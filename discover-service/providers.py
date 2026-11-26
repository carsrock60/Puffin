"""External music-data providers and caches for Puffin Discover.

All credentialed requests stay on the backend. The module returns normalized
metadata only, so the frontend never sees a project API key.
"""

from __future__ import annotations

import asyncio
import html as html_module
import logging
import os
import re
import time
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence

import httpx

from recommendations import clean_tags, is_uuid, normalize_name

logger = logging.getLogger("puffin.discover")
# Provider keys travel in query strings; keep HTTP client logs from recording them.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

LASTFM_URL = "https://ws.audioscrobbler.com/2.0/"
FANART_URL = "https://webservice.fanart.tv/v3/music"
MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2"
COVERART_URL = "https://coverartarchive.org/release-group"
ITUNES_URL = "https://itunes.apple.com/search"

LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"
SECONDARY_TYPES_EXCLUDED = {
    "compilation", "live", "soundtrack", "interview", "spokenword",
    "audio drama", "audiobook", "mixtape/street", "demo", "dj-mix",
    "field recording",
}

_MISSING = object()


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, Mapping):
        return [value]
    return []


class ProviderError(Exception):
    def __init__(self, provider: str, message: str, *, status_code: int = 502, retryable: bool = True, retry_after: float = 0.0):
        super().__init__(message)
        self.provider = provider
        self.message = message
        self.status_code = status_code
        self.retryable = retryable
        self.retry_after = retry_after


class RateLimitError(ProviderError):
    def __init__(self, provider: str, message: str, *, retry_after: float = 0.0):
        super().__init__(provider, message, status_code=503, retryable=True, retry_after=retry_after)


class TTLCache:
    """Small in-process TTL cache with per-key request de-duplication."""

    def __init__(self, max_entries: int = 900):
        self._entries: dict[str, tuple[float, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._max_entries = max_entries

    def _fresh(self, key: str) -> Any:
        entry = self._entries.get(key)
        if entry is None:
            return _MISSING
        expires_at, value = entry
        if expires_at <= time.monotonic():
            self._entries.pop(key, None)
            return _MISSING
        return value

    def peek(self, key: str) -> Any:
        value = self._fresh(key)
        return None if value is _MISSING else value

    def set(self, key: str, value: Any, ttl: float) -> None:
        if ttl <= 0:
            return
        if len(self._entries) >= self._max_entries:
            now = time.monotonic()
            for entry_key, (expires_at, _) in list(self._entries.items()):
                if expires_at <= now:
                    self._entries.pop(entry_key, None)
            if len(self._entries) >= self._max_entries:
                oldest = min(self._entries, key=lambda entry_key: self._entries[entry_key][0])
                self._entries.pop(oldest, None)
        self._entries[key] = (time.monotonic() + ttl, value)

    async def get_or_create(
        self,
        key: str,
        ttl: float,
        factory: Callable[[], Awaitable[Any]],
        *,
        negative_ttl: float | None = None,
    ) -> Any:
        value = self._fresh(key)
        if value is not _MISSING:
            return value
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            value = self._fresh(key)
            if value is not _MISSING:
                return value
            result = await factory()
            empty = result is None or result == [] or result == {} or result == ""
            self.set(key, result, (negative_ttl if empty and negative_ttl else ttl))
            return result


def ensure_https(value: Any) -> str:
    url = str(value or "").strip()
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    return url if url.startswith("https://") else ""


def select_lastfm_image(images: Sequence[Mapping[str, Any]]) -> str:
    rank = {"mega": 5, "extralarge": 4, "large": 3, "medium": 2, "small": 1}
    ordered = sorted(
        (item for item in (images or []) if isinstance(item, Mapping)),
        key=lambda item: rank.get(str(item.get("size") or "").casefold(), 0),
        reverse=True,
    )
    for item in ordered:
        url = ensure_https(item.get("text") or item.get("#text") or item.get("url"))
        if not url or LASTFM_PLACEHOLDER in url or "lastfm.freetls.fastly.net/i/u/300x300/2a96" in url:
            continue
        return url[:1000]
    return ""


def select_fanart_image(payload: Mapping[str, Any] | None) -> dict[str, str] | None:
    """Choose a real artist image, preferring portraits over backgrounds."""
    if not isinstance(payload, Mapping):
        return None
    for field, kind in (("artistthumb", "portrait"), ("artistbackground", "background")):
        choices: list[tuple[int, int, str]] = []
        for image in payload.get(field) or []:
            if not isinstance(image, Mapping):
                continue
            url = ensure_https(image.get("url"))
            if not url:
                continue
            host = (url.split("/", 3)[2] if url.count("/") >= 3 else "").split(":", 1)[0].casefold()
            if host != "fanart.tv" and not host.endswith(".fanart.tv"):
                continue
            try:
                width = int(image.get("width") or 0)
                height = int(image.get("height") or 0)
                likes = int(image.get("likes") or 0)
            except (TypeError, ValueError):
                width = height = likes = 0
            if width and width < 300:
                continue
            choices.append((likes, width * height, url[:1000]))
        if choices:
            best = max(choices, key=lambda item: (item[0], item[1], item[2]))
            return {"url": best[2], "kind": kind, "source": "Fanart.tv"}
    return None


def itunes_artwork(value: Any) -> str:
    url = ensure_https(value)
    if not url:
        return ""
    return re.sub(r"\d+x\d+bb", "600x600bb", url)


def filter_release_groups(groups: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    albums: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups or []:
        if not isinstance(group, Mapping):
            continue
        group_id = str(group.get("id") or "").strip()
        title = str(group.get("title") or "").strip()[:200]
        primary = str(group.get("primary-type") or "").strip().casefold()
        secondary = {str(value).strip().casefold() for value in (group.get("secondary-types") or [])}
        if not title or not is_uuid(group_id) or primary not in {"album", "ep"}:
            continue
        if secondary & SECONDARY_TYPES_EXCLUDED:
            continue
        key = normalize_name(title)
        if not key or key in seen:
            continue
        seen.add(key)
        date = str(group.get("first-release-date") or "")[:10]
        albums.append({
            "title": title,
            "year": date[:4] if len(date) >= 4 and date[:4].isdigit() else "",
            "releaseGroupId": group_id,
            "date": date,
        })
    albums.sort(key=lambda item: (item["date"] or "0000", item["title"].casefold()), reverse=True)
    return albums


def itunes_album_art_map(results: Sequence[Mapping[str, Any]], artist: str) -> dict[str, str]:
    artist_key = normalize_name(artist)
    mapped: dict[str, str] = {}
    for item in results or []:
        if str(item.get("collectionType") or "").casefold() != "album":
            continue
        if normalize_name(item.get("collectionArtistName") or item.get("artistName")) != artist_key:
            continue
        title = normalize_name(item.get("collectionName"))
        artwork = itunes_artwork(item.get("artworkUrl100"))
        if title and artwork and title not in mapped:
            mapped[title] = artwork
    return mapped


def find_itunes_album_art(artist: str, album: str, mapped: Mapping[str, str]) -> str:
    key = normalize_name(album)
    if not key:
        return ""
    if key in mapped:
        return mapped[key]
    prefix = key + " "
    candidates = [value for candidate, value in mapped.items() if candidate.startswith(prefix)]
    return min(candidates, key=len) if candidates else ""


def filter_itunes_albums(results: Sequence[Mapping[str, Any]], artist: str, limit: int = 4) -> list[dict[str, Any]]:
    artist_key = normalize_name(artist)
    seen: set[str] = set()
    albums: list[dict[str, Any]] = []
    for item in results or []:
        if str(item.get("collectionType") or "").casefold() != "album":
            continue
        if normalize_name(item.get("collectionArtistName") or item.get("artistName")) != artist_key:
            continue
        title = str(item.get("collectionName") or "").strip()[:200]
        key = normalize_name(title)
        if not title or not key or key in seen:
            continue
        seen.add(key)
        date = str(item.get("releaseDate") or "")[:10]
        albums.append({
            "title": title,
            "artist": artist,
            "year": date[:4] if len(date) >= 4 and date[:4].isdigit() else "",
            "date": date,
            "artwork": itunes_artwork(item.get("artworkUrl100")),
            "appleUrl": ensure_https(item.get("collectionViewUrl")),
            "source": "iTunes",
        })
    albums.sort(key=lambda item: (item["date"] or "0000", item["title"].casefold()), reverse=True)
    return albums[:limit]


def _escape_mb_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


class DiscoveryProviders:
    def __init__(self, *, lastfm_key: str = "", fanart_key: str = "", user_agent: str = ""):
        self.lastfm_key = lastfm_key.strip()
        self.fanart_key = fanart_key.strip()
        self.user_agent = user_agent.strip() or "Puffin/1.0 (https://github.com/carsrock60/Puffin)"
        self.cache = TTLCache()
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(8.0, connect=4.0),
            follow_redirects=True,
            limits=httpx.Limits(max_connections=12, max_keepalive_connections=6),
            headers={"Accept": "application/json"},
        )
        self._lastfm_sem = asyncio.Semaphore(4)
        self._lastfm_pace_lock = asyncio.Lock()
        self._lastfm_last_request = 0.0
        self._fanart_sem = asyncio.Semaphore(4)
        self._caa_sem = asyncio.Semaphore(2)
        self._mb_lock = asyncio.Lock()
        self._mb_last_request = 0.0
        self._lastfm_disabled_until = 0.0
        self._fanart_disabled_until = 0.0
        self._caa_disabled_until = 0.0

    @classmethod
    def from_env(cls) -> "DiscoveryProviders":
        return cls(
            lastfm_key=os.environ.get("LASTFM_API_KEY", ""),
            fanart_key=os.environ.get("FANART_API_KEY", ""),
            user_agent=os.environ.get("MUSICBRAINZ_USER_AGENT", ""),
        )

    @property
    def lastfm_configured(self) -> bool:
        return bool(self.lastfm_key)

    @property
    def fanart_configured(self) -> bool:
        return bool(self.fanart_key)

    def configuration(self) -> dict[str, bool]:
        return {
            "lastfm": bool(self.lastfm_key),
            "fanart": bool(self.fanart_key),
            "musicbrainz": True,
            "coverArtArchive": True,
            "itunes": True,
        }

    async def close(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        url: str,
        *,
        provider: str,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        attempts: int = 2,
    ) -> httpx.Response:
        for attempt in range(max(1, attempts)):
            try:
                response = await self._client.request(method, url, params=params, headers=headers)
            except (httpx.TimeoutException, httpx.TransportError) as error:
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.35 * (attempt + 1))
                    continue
                raise ProviderError(provider, f"{provider} could not be reached.") from error
            if response.status_code == 429:
                retry_after = 0.0
                try:
                    retry_after = min(30.0, max(0.0, float(response.headers.get("Retry-After", "0"))))
                except ValueError:
                    pass
                raise RateLimitError(provider, f"{provider} is limiting requests. Try again shortly.", retry_after=retry_after)
            if response.status_code in {500, 502, 503, 504} and attempt + 1 < attempts:
                await asyncio.sleep(0.45 * (attempt + 1))
                continue
            return response
        raise ProviderError(provider, f"{provider} did not respond.")

    @staticmethod
    def _json(response: httpx.Response, provider: str) -> Mapping[str, Any]:
        try:
            data = response.json()
        except ValueError as error:
            raise ProviderError(provider, f"{provider} returned an unreadable response.") from error
        return data if isinstance(data, Mapping) else {}

    async def _lastfm(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any] | None:
        if not self.lastfm_configured or time.monotonic() < self._lastfm_disabled_until:
            return None
        query = {"method": method, "api_key": self.lastfm_key, "format": "json", "autocorrect": 1, **params}
        async with self._lastfm_sem:
            async with self._lastfm_pace_lock:
                wait = 0.21 - (time.monotonic() - self._lastfm_last_request)
                if wait > 0:
                    await asyncio.sleep(wait)
                self._lastfm_last_request = time.monotonic()
            response = await self._request("GET", LASTFM_URL, provider="Last.fm", params=query, attempts=2)
        data = self._json(response, "Last.fm")
        if data.get("error") is not None:
            try:
                code = int(data.get("error"))
            except (TypeError, ValueError):
                code = 0
            if code == 29:
                raise RateLimitError("Last.fm", "Last.fm is limiting requests. Try again shortly.")
            if code in (6, 7):
                return None
            if code in (10, 13):
                self._lastfm_disabled_until = time.monotonic() + 600
                logger.warning("Last.fm rejected the configured project key")
                raise ProviderError(
                    "Last.fm",
                    "Discovery is temporarily unavailable. The Puffin host needs to reconnect its music catalog.",
                    status_code=503,
                    retryable=False,
                )
            if code in (8, 11, 16, 26):
                raise ProviderError("Last.fm", "Last.fm is temporarily unavailable.")
            return None
        if response.status_code >= 400:
            raise ProviderError("Last.fm", "Last.fm is temporarily unavailable.")
        return data

    async def artist_similar(self, seed) -> list[dict[str, Any]]:
        async def create() -> list[dict[str, Any]]:
            data = await self._lastfm("artist.getSimilar", {"artist": seed.name, "limit": 40})
            artists = _as_list(((data or {}).get("similarartists") or {}).get("artist"))
            hits: list[dict[str, Any]] = []
            for item in artists:
                if not isinstance(item, Mapping):
                    continue
                name = str(item.get("name") or "").strip()[:200]
                if not name:
                    continue
                hits.append({
                    "name": name,
                    "mbid": str(item.get("mbid") or "").strip(),
                    "match": item.get("match", 0),
                    "url": str(item.get("url") or "").strip(),
                })
            return hits

        return await self.cache.get_or_create(
            f"lastfm:artist-similar:{seed.key}", 24 * 3600, create, negative_ttl=3600,
        )

    async def track_similar(self, seed) -> list[dict[str, Any]]:
        if not seed.sample_tracks:
            return []
        track = seed.sample_tracks[0]

        async def create() -> list[dict[str, Any]]:
            data = await self._lastfm("track.getSimilar", {"artist": seed.name, "track": track, "limit": 30})
            tracks = _as_list(((data or {}).get("similartracks") or {}).get("track"))
            hits: list[dict[str, Any]] = []
            for item in tracks:
                if not isinstance(item, Mapping):
                    continue
                artist = item.get("artist") if isinstance(item.get("artist"), Mapping) else {}
                name = str(artist.get("name") or "").strip()[:200]
                if not name:
                    continue
                hits.append({
                    "name": name,
                    "mbid": str(artist.get("mbid") or "").strip(),
                    "match": item.get("match", 0),
                    "url": str(item.get("url") or "").strip(),
                    "track_title": track,
                })
            return hits

        return await self.cache.get_or_create(
            f"lastfm:track-similar:{seed.key}:{normalize_name(track)[:80]}", 24 * 3600, create, negative_ttl=3600,
        )

    async def artist_info(self, name: str) -> dict[str, Any]:
        cache_key = f"lastfm:artist-info:{normalize_name(name)}"

        async def create() -> dict[str, Any]:
            data = await self._lastfm("artist.getInfo", {"artist": name})
            artist = (data or {}).get("artist")
            if not isinstance(artist, Mapping):
                return {}
            stats = artist.get("stats") if isinstance(artist.get("stats"), Mapping) else {}
            tags = artist.get("tags") if isinstance(artist.get("tags"), Mapping) else {}
            tag_items = _as_list(tags.get("tag"))
            bio = artist.get("bio") if isinstance(artist.get("bio"), Mapping) else {}
            return {
                "name": str(artist.get("name") or name)[:200],
                "mbid": str(artist.get("mbid") or "").strip(),
                "url": ensure_https(artist.get("url")),
                "image": select_lastfm_image(artist.get("image") or []),
                "tags": clean_tags([item.get("name") for item in tag_items if isinstance(item, Mapping)], limit=6),
                "bio": _strip_html(bio.get("summary") or ""),
                "listeners": _int(stats.get("listeners")),
                "playcount": _int(stats.get("playcount")),
            }

        return await self.cache.get_or_create(cache_key, 7 * 24 * 3600, create, negative_ttl=12 * 3600)

    async def artist_infos(self, names: Iterable[str]) -> dict[str, dict[str, Any]]:
        unique = []
        seen: set[str] = set()
        for name in names:
            key = normalize_name(name)
            if key and key not in seen:
                seen.add(key)
                unique.append((key, name))
        semaphore = asyncio.Semaphore(4)

        async def load(key: str, name: str) -> tuple[str, dict[str, Any]]:
            async with semaphore:
                try:
                    return key, await self.artist_info(name)
                except ProviderError as error:
                    logger.warning("Artist metadata lookup failed: %s", error.message)
                    return key, {}

        results = await asyncio.gather(*(load(key, name) for key, name in unique))
        return dict(results)

    async def artist_top_tracks(self, name: str, limit: int = 5) -> list[dict[str, Any]]:
        async def create() -> list[dict[str, Any]]:
            data = await self._lastfm("artist.getTopTracks", {"artist": name, "limit": max(1, min(limit, 10))})
            tracks = _as_list(((data or {}).get("toptracks") or {}).get("track"))
            result: list[dict[str, Any]] = []
            for item in tracks:
                if not isinstance(item, Mapping):
                    continue
                title = str(item.get("name") or "").strip()[:200]
                if not title:
                    continue
                result.append({
                    "title": title,
                    "listeners": _int(item.get("listeners")),
                    "playcount": _int(item.get("playcount")),
                    "url": ensure_https(item.get("url")),
                })
            return result

        return await self.cache.get_or_create(
            f"lastfm:top-tracks:{normalize_name(name)}", 7 * 24 * 3600, create, negative_ttl=6 * 3600,
        )

    async def resolve_mbid(self, name: str, mbid: str = "") -> str:
        if is_uuid(mbid):
            return mbid.strip()
        info = await self.artist_info(name)
        if is_uuid(info.get("mbid")):
            return str(info["mbid"]).strip()
        return await self._mb_artist_search(name)

    async def _mb_request(self, path: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        headers = {"User-Agent": self.user_agent}
        for attempt in range(2):
            try:
                async with self._mb_lock:
                    wait = 1.05 - (time.monotonic() - self._mb_last_request)
                    if wait > 0:
                        await asyncio.sleep(wait)
                    try:
                        response = await self._client.get(f"{MUSICBRAINZ_URL}{path}", params=params, headers=headers)
                    finally:
                        self._mb_last_request = time.monotonic()
            except httpx.HTTPError as error:
                if attempt == 0:
                    await asyncio.sleep(0.6)
                    continue
                raise ProviderError("MusicBrainz", "MusicBrainz could not be reached.") from error
            if response.status_code in {500, 502, 503, 504} and attempt == 0:
                await asyncio.sleep(1.0)
                continue
            if response.status_code == 429:
                raise RateLimitError("MusicBrainz", "MusicBrainz is limiting requests. Try again shortly.")
            if response.status_code >= 400:
                raise ProviderError("MusicBrainz", "MusicBrainz is temporarily unavailable.")
            return self._json(response, "MusicBrainz")
        raise ProviderError("MusicBrainz", "MusicBrainz is temporarily unavailable.")

    async def _mb_artist_search(self, name: str) -> str:
        cache_key = f"mb:artist-search:{normalize_name(name)}"

        async def create() -> str:
            query = f'artist:"{_escape_mb_query(name)}"'
            data = await self._mb_request("/artist", {"query": query, "fmt": "json", "limit": 5})
            candidates = data.get("artists") or []
            target = normalize_name(name)
            best = ""
            best_score = -1
            for item in candidates:
                if not isinstance(item, Mapping) or normalize_name(item.get("name")) != target:
                    continue
                score = _int(item.get("score"))
                if score > best_score and is_uuid(item.get("id")):
                    best = str(item["id"]).strip()
                    best_score = score
            return best

        return await self.cache.get_or_create(cache_key, 30 * 24 * 3600, create, negative_ttl=3 * 24 * 3600)

    async def release_groups(self, mbid: str) -> list[dict[str, Any]]:
        if not is_uuid(mbid):
            return []

        async def create() -> list[dict[str, Any]]:
            data = await self._mb_request(
                "/release-group",
                {"artist": mbid, "inc": "artist-credits", "limit": 30, "fmt": "json"},
            )
            return filter_release_groups(data.get("release-groups") or [])

        return await self.cache.get_or_create(f"mb:release-groups:{mbid}", 7 * 24 * 3600, create, negative_ttl=12 * 3600)

    async def fanart_image(self, mbid: str) -> dict[str, str] | None:
        if not self.fanart_configured or not is_uuid(mbid) or time.monotonic() < self._fanart_disabled_until:
            return None

        async def create() -> dict[str, str] | None:
            async with self._fanart_sem:
                response = await self._request(
                    "GET", f"{FANART_URL}/{mbid}", provider="Fanart.tv",
                    params={"api_key": self.fanart_key}, attempts=1,
                )
            if response.status_code in (401, 403):
                self._fanart_disabled_until = time.monotonic() + 600
                logger.warning("Fanart.tv rejected the configured project key")
                return None
            if response.status_code == 404:
                return None
            if response.status_code >= 400:
                raise ProviderError("Fanart.tv", "Fanart.tv is temporarily unavailable.")
            return select_fanart_image(self._json(response, "Fanart.tv"))

        return await self.cache.get_or_create(f"fanart:music:{mbid}", 7 * 24 * 3600, create, negative_ttl=12 * 3600)

    async def artist_image(self, name: str, mbid: str = "", lastfm_image: str = "") -> dict[str, str] | None:
        if is_uuid(mbid):
            try:
                image = await self.fanart_image(mbid)
            except ProviderError as error:
                logger.warning("Artist image lookup failed: %s", error.message)
                image = None
            if image:
                return image
        fallback = ensure_https(lastfm_image)
        if fallback and LASTFM_PLACEHOLDER not in fallback:
            return {"url": fallback[:1000], "kind": "portrait", "source": "Last.fm"}
        return None

    async def _itunes_results(self, artist: str) -> list[dict[str, Any]]:
        cache_key = f"itunes:album-search:{normalize_name(artist)}"

        async def create() -> list[dict[str, Any]]:
            response = await self._request(
                "GET", ITUNES_URL, provider="iTunes", attempts=1,
                params={"term": artist, "entity": "album", "limit": 30, "country": "US"},
            )
            if response.status_code >= 400:
                raise ProviderError("iTunes", "iTunes artwork is temporarily unavailable.")
            data = self._json(response, "iTunes")
            results = data.get("results")
            return [item for item in results if isinstance(item, Mapping)] if isinstance(results, list) else []

        return await self.cache.get_or_create(cache_key, 7 * 24 * 3600, create, negative_ttl=6 * 3600)

    async def itunes_album_map(self, artist: str) -> dict[str, str]:
        try:
            return itunes_album_art_map(await self._itunes_results(artist), artist)
        except ProviderError as error:
            logger.warning("iTunes artwork lookup failed: %s", error.message)
            return {}

    async def itunes_albums(self, artist: str, limit: int = 4) -> list[dict[str, Any]]:
        try:
            return filter_itunes_albums(await self._itunes_results(artist), artist, limit)
        except ProviderError as error:
            logger.warning("iTunes album lookup failed: %s", error.message)
            return []

    async def caa_artwork(self, release_group_id: str) -> str:
        if not is_uuid(release_group_id) or time.monotonic() < self._caa_disabled_until:
            return ""

        async def create() -> str:
            url = f"{COVERART_URL}/{release_group_id}/front-500"
            try:
                async with self._caa_sem:
                    response = await self._client.head(url, timeout=6.0)
            except httpx.HTTPError:
                return ""
            if response.status_code == 429:
                self._caa_disabled_until = time.monotonic() + 300
                raise RateLimitError("Cover Art Archive", "Cover Art Archive is limiting requests.")
            if response.status_code >= 400:
                return ""
            return url

        return await self.cache.get_or_create(f"caa:front-500:{release_group_id}", 7 * 24 * 3600, create, negative_ttl=3 * 24 * 3600)

    async def artist_albums(self, name: str, mbid: str = "", limit: int = 3) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 6))
        cache_key = f"albums:{normalize_name(name)}:{mbid}:{limit}"

        async def create() -> list[dict[str, Any]]:
            if is_uuid(mbid):
                try:
                    groups = await self.release_groups(mbid)
                except ProviderError as error:
                    logger.warning("MusicBrainz album lookup failed: %s", error.message)
                    groups = []
                if groups:
                    selected_groups = groups[:limit]

                    async def cover(group: Mapping[str, Any]) -> tuple[str, str]:
                        try:
                            artwork = await self.caa_artwork(group["releaseGroupId"])
                            return (artwork, "Cover Art Archive") if artwork else ("", "")
                        except ProviderError as error:
                            logger.warning("Cover Art Archive lookup failed: %s", error.message)
                            return "", ""

                    covers = await asyncio.gather(*(cover(group) for group in selected_groups))
                    itunes_map = await self.itunes_album_map(name) if any(not artwork for artwork, _ in covers) else {}
                    albums: list[dict[str, Any]] = []
                    for group, (artwork, artwork_source) in zip(selected_groups, covers):
                        if not artwork:
                            artwork = find_itunes_album_art(name, group["title"], itunes_map)
                            if artwork:
                                artwork_source = "iTunes"
                        albums.append({
                            "title": group["title"],
                            "artist": name,
                            "year": group.get("year", ""),
                            "artwork": artwork,
                            "releaseGroupId": group["releaseGroupId"],
                            "source": artwork_source,
                        })
                    if albums:
                        return albums
            return await self.itunes_albums(name, limit)

        return await self.cache.get_or_create(cache_key, 6 * 3600, create, negative_ttl=3600)

    async def artist_detail(self, name: str, mbid: str = "") -> dict[str, Any]:
        info: dict[str, Any] = {}
        try:
            info = await self.artist_info(name)
        except ProviderError as error:
            logger.warning("Artist info lookup failed: %s", error.message)
        resolved_mbid = mbid if is_uuid(mbid) else info.get("mbid") or ""
        if not is_uuid(resolved_mbid):
            try:
                resolved_mbid = await self._mb_artist_search(name)
            except ProviderError as error:
                logger.warning("MusicBrainz artist lookup failed: %s", error.message)
                resolved_mbid = ""
        image = None
        try:
            image = await self.artist_image(name, resolved_mbid, info.get("image", ""))
        except ProviderError as error:
            logger.warning("Artist image lookup failed: %s", error.message)
        async def album_task() -> list[dict[str, Any]]:
            try:
                return await self.artist_albums(name, resolved_mbid, 4)
            except ProviderError as error:
                logger.warning("Artist album lookup failed: %s", error.message)
                return []

        async def track_task() -> list[dict[str, Any]]:
            try:
                return await self.artist_top_tracks(name, 5)
            except ProviderError as error:
                logger.warning("Artist track lookup failed: %s", error.message)
                return []

        albums, tracks = await asyncio.gather(album_task(), track_task())
        return {
            "name": info.get("name") or name,
            "mbid": resolved_mbid if is_uuid(resolved_mbid) else "",
            "image": image.get("url") if image else "",
            "imageSource": image.get("source") if image else "",
            "tags": info.get("tags") or [],
            "bio": info.get("bio") or "",
            "lastfmUrl": info.get("url") or "",
            "albums": albums,
            "topTracks": tracks,
        }


def _int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _strip_html(value: Any) -> str:
    text = html_module.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s*Read more on Last\.fm\.?\s*$", "", text, flags=re.IGNORECASE).strip()
    if len(text) > 700:
        text = text[:697].rsplit(" ", 1)[0] + "…"
    return text
