"""Puffin Discover API.

Last.fm supplies artist and track similarity. MusicBrainz and Cover Art
Archive supply release metadata and artwork, Fanart.tv supplies artist
photography, and iTunes supplies artwork fallbacks. Project credentials live
only in backend environment variables.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

import recommendations as ranking
from providers import DiscoveryProviders, ProviderError, RateLimitError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("puffin.discover")

FINAL_CACHE_TTL = 45 * 60
EMPTY_CACHE_TTL = 5 * 60
ALBUM_ARTIST_LIMIT = 3
CANDIDATE_INFO_LIMIT = 24
# Keep a slow MusicBrainz lookup from consuming the whole client request budget.
MBID_RESOLUTION_LIMIT = 8


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.providers = DiscoveryProviders.from_env()
    try:
        yield
    finally:
        await app.state.providers.close()


app = FastAPI(title="Puffin Discover", version="1.0", lifespan=lifespan)


class SeedArtist(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=200)
    play_count: int = Field(default=0, ge=0, le=1_000_000)
    library_count: int = Field(default=0, ge=0, le=100_000)
    recent_rank: int | None = Field(default=None, ge=0, le=10_000)
    sample_tracks: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("sample_tracks")
    @classmethod
    def clean_tracks(cls, values: list[str]) -> list[str]:
        return [str(value).strip()[:200] for value in values if str(value).strip()][:3]


class RecommendationsRequest(BaseModel):
    artists: list[SeedArtist] = Field(default_factory=list, max_length=10)
    known_artists: list[str] = Field(default_factory=list, max_length=60)
    seen_artists: list[str] = Field(default_factory=list, max_length=120)
    limit: int = Field(default=12, ge=6, le=18)
    refresh: bool = False

    @field_validator("known_artists", "seen_artists")
    @classmethod
    def clean_names(cls, values: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for value in values:
            name = str(value or "").strip()[:200]
            key = ranking.normalize_name(name)
            if not key or key in seen:
                continue
            seen.add(key)
            cleaned.append(name)
        return cleaned


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _error_response(status_code: int, message: str, *, retryable: bool = True, configured: dict[str, bool] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "error",
            "message": message,
            "retryable": retryable,
            "configured": configured or {},
            "generatedAt": _now_iso(),
        },
    )


async def _load_similarities(
    providers: DiscoveryProviders,
    seeds: list[ranking.Seed],
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]], list[ProviderError]]:
    artist_hits: dict[str, list[dict[str, Any]]] = {}
    track_hits: dict[str, list[dict[str, Any]]] = {}
    failures: list[ProviderError] = []
    gate = asyncio.Semaphore(4)
    stop = asyncio.Event()

    async def load_artist(seed: ranking.Seed) -> None:
        if stop.is_set():
            artist_hits[seed.key] = []
            return
        async with gate:
            if stop.is_set():
                artist_hits[seed.key] = []
                return
            try:
                artist_hits[seed.key] = await providers.artist_similar(seed)
            except RateLimitError as error:
                stop.set()
                failures.append(error)
                artist_hits[seed.key] = []
            except ProviderError as error:
                failures.append(error)
                artist_hits[seed.key] = []

    async def load_track(seed: ranking.Seed) -> None:
        if stop.is_set() or not seed.sample_tracks:
            return
        async with gate:
            if stop.is_set():
                track_hits[seed.key] = []
                return
            try:
                track_hits[seed.key] = await providers.track_similar(seed)
            except RateLimitError as error:
                stop.set()
                failures.append(error)
                track_hits[seed.key] = []
            except ProviderError as error:
                failures.append(error)
                track_hits[seed.key] = []

    track_seeds = [seed for seed in seeds if seed.sample_tracks][:4]
    await asyncio.gather(
        *(load_artist(seed) for seed in seeds),
        *(load_track(seed) for seed in track_seeds),
    )
    return artist_hits, track_hits, failures


async def _enrich_recommendations(
    providers: DiscoveryProviders,
    selected: list[ranking.Candidate],
    seeds_by_key: dict[str, ranking.Seed],
) -> list[dict[str, Any]]:
    image_gate = asyncio.Semaphore(4)
    mbid_gate = asyncio.Semaphore(3)

    async def enrich(index: int, candidate: ranking.Candidate) -> dict[str, Any]:
        mbid = candidate.mbid
        if not ranking.is_uuid(mbid) and index < MBID_RESOLUTION_LIMIT:
            async with mbid_gate:
                try:
                    mbid = await providers.resolve_mbid(candidate.name)
                except ProviderError as error:
                    logger.warning("MusicBrainz artist lookup failed: %s", error.message)
                    mbid = ""
        if not ranking.is_uuid(mbid):
            mbid = ""

        async def image_task() -> dict[str, str] | None:
            async with image_gate:
                try:
                    return await providers.artist_image(candidate.name, mbid, candidate.lastfm_image)
                except ProviderError as error:
                    logger.warning("Artist image lookup failed: %s", error.message)
                    return None

        async def album_task() -> list[dict[str, Any]]:
            if index >= ALBUM_ARTIST_LIMIT:
                return []
            try:
                return await providers.artist_albums(candidate.name, mbid, 3)
            except ProviderError as error:
                logger.warning("Artist album lookup failed: %s", error.message)
                return []

        image, albums = await asyncio.gather(image_task(), album_task())
        reason = ranking.recommendation_reason(candidate, seeds_by_key)
        return {
            "id": ranking.stable_id(candidate.name),
            "name": candidate.name,
            "mbid": mbid,
            "image": image.get("url", "") if image else "",
            "imageSource": image.get("source", "") if image else "",
            "imageKind": image.get("kind", "") if image else "",
            "reason": reason,
            "tags": candidate.tags[:3],
            "albums": albums,
            "lastfmUrl": candidate.lastfm_url,
            "seedName": seeds_by_key[candidate.best_seed_key].name if candidate.best_seed_key in seeds_by_key else "",
        }

    return await asyncio.gather(*(enrich(index, candidate) for index, candidate in enumerate(selected)))


async def _build_recommendations(
    providers: DiscoveryProviders,
    request: RecommendationsRequest,
) -> dict[str, Any]:
    seeds = ranking.build_seeds([seed.model_dump() for seed in request.artists])
    if not seeds:
        return {
            "status": "empty",
            "message": "Add a few artists to your library so Puffin can learn what you like.",
            "seeds": [],
            "recommendations": [],
            "albums": [],
        }

    known_keys = {ranking.normalize_name(name) for name in request.known_artists}
    seen_keys = {ranking.normalize_name(name) for name in request.seen_artists}
    artist_hits, track_hits, failures = await _load_similarities(providers, seeds)
    candidates = ranking.merge_similarities(seeds, artist_hits, track_hits, known_keys)

    if not candidates and failures:
        raise failures[0]

    top_candidates = candidates[:CANDIDATE_INFO_LIMIT]
    infos = await providers.artist_infos(candidate.name for candidate in top_candidates)
    ranking.apply_artist_info(top_candidates, infos)
    selected = ranking.rank_candidates(
        top_candidates,
        [seed.key for seed in seeds],
        request.limit,
        seen_keys,
    )
    seeds_by_key = {seed.key: seed for seed in seeds}
    enriched = await _enrich_recommendations(providers, selected, seeds_by_key)
    albums = ranking.select_album_highlights(enriched, 10)

    recommendations = []
    for item in enriched:
        if not item.get("image"):
            item["image"] = ""
        recommendations.append(item)

    return {
        "status": "ok" if recommendations else "empty",
        "message": "" if recommendations else "Puffin could not find new artists for you right now. Try again later.",
        "seeds": [
            {
                "name": seed.name,
                "source": "history" if seed.play_count > 0 else "library",
            }
            for seed in seeds
        ],
        "recommendations": recommendations,
        "albums": albums,
        "partial": bool(failures),
    }


@app.get("/api/discover/health")
async def health(request: Request) -> dict[str, Any]:
    providers: DiscoveryProviders = request.app.state.providers
    return {
        "status": "ok",
        "configured": providers.configuration(),
        "cache": {"finalTtlSeconds": FINAL_CACHE_TTL},
    }


@app.post("/api/discover/recommendations")
async def recommendations(request_body: RecommendationsRequest, request: Request) -> JSONResponse:
    providers: DiscoveryProviders = request.app.state.providers
    configured = providers.configuration()
    if not providers.lastfm_configured:
        return JSONResponse(
            status_code=200,
            content={
                "status": "unconfigured",
                "message": "Puffin’s discovery service is not configured yet. Recommendations will return once its music catalog is connected.",
                "configured": configured,
                "seeds": [],
                "recommendations": [],
                "albums": [],
                "generatedAt": _now_iso(),
            },
        )

    seeds = ranking.build_seeds([seed.model_dump() for seed in request_body.artists])
    if not seeds:
        return JSONResponse(
            status_code=200,
            content={
                "status": "empty",
                "message": "Add a few artists to your library so Puffin can learn what you like.",
                "configured": configured,
                "seeds": [],
                "recommendations": [],
                "albums": [],
                "generatedAt": _now_iso(),
            },
        )

    known_keys = {ranking.normalize_name(name) for name in request_body.known_artists}
    seen_keys = {ranking.normalize_name(name) for name in request_body.seen_artists}
    cache_key = "final:" + ranking.fingerprint(seeds, known_keys, seen_keys, request_body.limit)
    if not request_body.refresh:
        cached = providers.cache.peek(cache_key)
        if cached is not None:
            payload = dict(cached)
            payload["cache"] = {"hit": True, "ttlSeconds": FINAL_CACHE_TTL}
            payload["configured"] = configured
            return JSONResponse(status_code=200, content=payload)

    try:
        payload = await _build_recommendations(providers, request_body)
    except RateLimitError as error:
        return _error_response(503, error.message, configured=configured)
    except ProviderError as error:
        return _error_response(error.status_code, error.message, retryable=error.retryable, configured=configured)

    payload["configured"] = configured
    payload["generatedAt"] = _now_iso()
    payload["cache"] = {"hit": False, "ttlSeconds": FINAL_CACHE_TTL}
    providers.cache.set(
        cache_key,
        payload,
        FINAL_CACHE_TTL if payload.get("recommendations") else EMPTY_CACHE_TTL,
    )
    return JSONResponse(status_code=200, content=payload)


@app.get("/api/discover/artist")
async def artist(
    request: Request,
    name: str = Query(min_length=1, max_length=200),
    mbid: str = Query(default="", max_length=64),
) -> JSONResponse:
    providers: DiscoveryProviders = request.app.state.providers
    configured = providers.configuration()
    clean_name = name.strip()
    if not clean_name:
        return _error_response(400, "Choose an artist to explore.", retryable=False, configured=configured)
    valid_mbid = mbid if ranking.is_uuid(mbid) else ""
    cache_key = f"detail:{ranking.normalize_name(clean_name)}:{valid_mbid}"

    try:
        detail = await providers.cache.get_or_create(
            cache_key,
            2 * 3600,
            lambda: providers.artist_detail(clean_name, valid_mbid),
            negative_ttl=10 * 60,
        )
    except RateLimitError as error:
        return _error_response(503, error.message, configured=configured)
    except ProviderError as error:
        return _error_response(error.status_code, error.message, retryable=error.retryable, configured=configured)

    return JSONResponse(
        status_code=200,
        content={
            "status": "ok",
            "artist": detail,
            "configured": configured,
            "generatedAt": _now_iso(),
        },
    )
