"""Pure recommendation ranking and normalization helpers for Puffin Discover.

The functions in this module deliberately contain no network access so the
personalization and diversity policy can be tested in isolation.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
TAG_BLOCKLIST = {
    "seen live", "favorite", "favourite", "favorites", "favourites", "love",
    "awesome", "beautiful", "best", "good", "great", "cool", "amazing",
    "male vocalists", "female vocalists", "under 2000 listeners",
    "albums i own", "owned", "spotify", "lastfm", "last.fm",
}
MAX_PER_SEED = 2
SEEN_PENALTY = 0.55
TAG_OVERLAP_PENALTY = 0.32


def normalize_name(value: Any) -> str:
    """Return a stable, case-insensitive key for an artist or album name."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = text.casefold().replace("&", " and ")
    text = re.sub(r"[_\W]+", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def normalize_tag(value: Any) -> str:
    tag = re.sub(r"\s+", " ", str(value or "").strip().casefold())
    return tag if tag and tag not in TAG_BLOCKLIST else ""


def clean_tags(values: Iterable[Any], limit: int = 4) -> list[str]:
    seen: set[str] = set()
    tags: list[str] = []
    for value in values or []:
        tag = normalize_tag(value)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag[:40])
        if len(tags) >= limit:
            break
    return tags


def is_uuid(value: Any) -> bool:
    return bool(UUID_RE.match(str(value or "").strip()))


def stable_id(value: Any) -> str:
    return hashlib.sha1(normalize_name(value).encode("utf-8")).hexdigest()[:12]


@dataclass(frozen=True)
class Seed:
    name: str
    play_count: int = 0
    library_count: int = 0
    recent_rank: int | None = None
    sample_tracks: tuple[str, ...] = ()
    weight: float = 0.0

    @property
    def key(self) -> str:
        return normalize_name(self.name)


@dataclass
class Candidate:
    name: str
    key: str
    mbid: str = ""
    lastfm_url: str = ""
    lastfm_image: str = ""
    tags: list[str] = field(default_factory=list)
    sources: dict[str, float] = field(default_factory=dict)
    source_weights: dict[str, float] = field(default_factory=dict)
    matches: dict[str, float] = field(default_factory=dict)
    track_titles: dict[str, str] = field(default_factory=dict)
    support: int = 0
    relevance: float = 0.0
    best_seed_key: str = ""
    best_source: str = "artist"
    info_listeners: int = 0
    info_playcount: int = 0


def build_seeds(raw_seeds: Sequence[Mapping[str, Any]]) -> list[Seed]:
    """Turn the compact client profile into normalized, weighted seeds."""
    merged: dict[str, dict[str, Any]] = {}
    for raw in raw_seeds:
        name = str(raw.get("name") or "").strip()[:200]
        key = normalize_name(name)
        if not key:
            continue
        tracks = tuple(
            str(item).strip()[:200]
            for item in (raw.get("sample_tracks") or [])
            if str(item).strip()
        )[:3]
        item = merged.setdefault(key, {
            "name": name,
            "play_count": 0,
            "library_count": 0,
            "recent_rank": None,
            "sample_tracks": [],
        })
        item["play_count"] = max(item["play_count"], int(raw.get("play_count") or 0))
        item["library_count"] = max(item["library_count"], int(raw.get("library_count") or 0))
        rank = raw.get("recent_rank")
        if isinstance(rank, int) and rank >= 0:
            item["recent_rank"] = rank if item["recent_rank"] is None else min(item["recent_rank"], rank)
        for track in tracks:
            if track not in item["sample_tracks"] and len(item["sample_tracks"]) < 3:
                item["sample_tracks"].append(track)

    seeds: list[Seed] = []
    for item in merged.values():
        play_count = max(0, min(item["play_count"], 1_000_000))
        library_count = max(0, min(item["library_count"], 100_000))
        recent_rank = item["recent_rank"]
        recent = 0.0 if recent_rank is None else max(0.0, 1.0 - min(recent_rank, 30) / 30.0)
        weight = 0.4 + math.log1p(play_count) * 1.15 + recent * 0.9 + math.log1p(library_count) * 0.3
        seeds.append(Seed(
            name=item["name"],
            play_count=play_count,
            library_count=library_count,
            recent_rank=recent_rank,
            sample_tracks=tuple(item["sample_tracks"]),
            weight=round(weight, 4),
        ))

    seeds.sort(key=lambda seed: (-seed.weight, -seed.library_count, seed.name.casefold()))
    return seeds[:10]


def _clamp_match(value: Any) -> float:
    try:
        match = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(match, 1.0))


def merge_similarities(
    seeds: Sequence[Seed],
    artist_hits: Mapping[str, Sequence[Mapping[str, Any]]],
    track_hits: Mapping[str, Sequence[Mapping[str, Any]]],
    known_keys: Iterable[str],
) -> list[Candidate]:
    """Merge Last.fm artist and track similarity results into candidates.

    ``artist_hits`` maps a seed key to normalized hits with name/mbid/match.
    ``track_hits`` maps a seed key to normalized hits with name/mbid/match and
    track_title. A track relationship contributes less than a direct artist
    relationship, and a candidate supported by several seeds is boosted once.
    """
    seed_by_key = {seed.key: seed for seed in seeds}
    excluded = set(known_keys) | set(seed_by_key)
    candidates: dict[str, Candidate] = {}

    def add_hit(seed_key: str, hit: Mapping[str, Any], source: str) -> None:
        seed = seed_by_key.get(seed_key)
        if seed is None:
            return
        name = str(hit.get("name") or "").strip()[:200]
        key = normalize_name(name)
        if not key or key in excluded:
            return
        match = _clamp_match(hit.get("match"))
        if match <= 0:
            return
        source_weight = 1.0 if source == "artist" else 0.35
        contribution = match * seed.weight * source_weight
        candidate = candidates.get(key)
        if candidate is None:
            candidate = Candidate(name=name, key=key)
            candidates[key] = candidate
        candidate.sources[seed_key] = max(candidate.sources.get(seed_key, 0.0), contribution)
        candidate.source_weights[seed_key] = max(candidate.source_weights.get(seed_key, 0.0), source_weight)
        candidate.matches[seed_key] = max(candidate.matches.get(seed_key, 0.0), match)
        if source == "track" and hit.get("track_title"):
            candidate.track_titles.setdefault(seed_key, str(hit["track_title"])[:200])
        if not candidate.mbid and is_uuid(hit.get("mbid")):
            candidate.mbid = str(hit["mbid"]).strip()
        if not candidate.lastfm_url and str(hit.get("url") or "").startswith("https://"):
            candidate.lastfm_url = str(hit["url"])[:500]

    for seed in seeds:
        for hit in artist_hits.get(seed.key, ()):
            add_hit(seed.key, hit, "artist")
        for hit in track_hits.get(seed.key, ()):
            add_hit(seed.key, hit, "track")

    for candidate in candidates.values():
        candidate.support = len(candidate.sources)
        weight_total = 0.0
        contribution_total = 0.0
        for seed_key, contribution in candidate.sources.items():
            seed = seed_by_key[seed_key]
            # Track similarity contributes a smaller share than a direct artist
            # match. Dividing by the full seed weight keeps that difference in
            # the final relevance instead of normalizing it away.
            weight_total += seed.weight
            contribution_total += contribution
        candidate.relevance = contribution_total / weight_total if weight_total else 0.0
        candidate.relevance = min(1.0, candidate.relevance + 0.06 * max(0, candidate.support - 1))
        best_key = max(candidate.sources, key=lambda key: (candidate.sources[key], candidate.matches[key]))
        candidate.best_seed_key = best_key
        candidate.best_source = "track" if best_key in candidate.track_titles else "artist"

    return sorted(candidates.values(), key=lambda item: (-item.relevance, item.name.casefold()))


def apply_artist_info(candidates: Sequence[Candidate], info_by_key: Mapping[str, Mapping[str, Any]]) -> None:
    for candidate in candidates:
        info = info_by_key.get(candidate.key) or {}
        mbid = str(info.get("mbid") or "").strip()
        if is_uuid(mbid):
            candidate.mbid = mbid
        tags = clean_tags(info.get("tags") or [])
        if tags:
            candidate.tags = tags
        image = str(info.get("image") or "").strip()
        if image.startswith("https://"):
            candidate.lastfm_image = image[:1000]
        url = str(info.get("url") or "").strip()
        if url.startswith("https://"):
            candidate.lastfm_url = url[:500]
        candidate.info_listeners = max(0, int(info.get("listeners") or 0))
        candidate.info_playcount = max(0, int(info.get("playcount") or 0))


def _tag_overlap(tags: Sequence[str], selected_tags: set[str]) -> float:
    if not tags or not selected_tags:
        return 0.0
    tag_set = set(tags)
    union = tag_set | selected_tags
    return len(tag_set & selected_tags) / len(union) if union else 0.0


def rank_candidates(
    candidates: Sequence[Candidate],
    seed_order: Sequence[str],
    limit: int,
    seen_keys: Iterable[str] = (),
    max_per_seed: int = MAX_PER_SEED,
) -> list[Candidate]:
    """Greedy relevance/diversity ranking with source caps and tag spacing."""
    seen = set(seen_keys)
    order = {key: index for index, key in enumerate(seed_order)}
    remaining = list(candidates)
    selected: list[Candidate] = []
    selected_tags: set[str] = set()
    per_seed: Counter[str] = Counter()

    def pick(limit_per_seed: int) -> bool:
        best: Candidate | None = None
        best_score = -1.0
        best_tie = (999, "")
        for candidate in remaining:
            if per_seed[candidate.best_seed_key] >= limit_per_seed:
                continue
            overlap = _tag_overlap(candidate.tags, selected_tags)
            source_bonus = 0.05 if per_seed[candidate.best_seed_key] == 0 else 0.0
            score = candidate.relevance * (1.0 - TAG_OVERLAP_PENALTY * overlap) + source_bonus
            if candidate.key in seen:
                score *= SEEN_PENALTY
            tie = (order.get(candidate.best_seed_key, 99), candidate.name.casefold())
            if score > best_score + 1e-9 or (abs(score - best_score) <= 1e-9 and tie < best_tie):
                best = candidate
                best_score = score
                best_tie = tie
        if best is None:
            return False
        remaining.remove(best)
        selected.append(best)
        per_seed[best.best_seed_key] += 1
        selected_tags.update(best.tags)
        return True

    while len(selected) < limit and pick(max_per_seed):
        pass
    while len(selected) < limit and pick(limit):
        pass
    return selected


def recommendation_reason(candidate: Candidate, seeds_by_key: Mapping[str, Seed]) -> str:
    best_key = candidate.best_seed_key
    if not best_key and candidate.sources:
        best_key = max(candidate.sources, key=lambda key: candidate.sources[key])
    seed = seeds_by_key.get(best_key)
    if seed is None:
        return "Picked for you"
    other_keys = [
        key for key in sorted(candidate.sources, key=lambda key: -candidate.sources[key])
        if key != best_key
    ]
    if other_keys:
        other = seeds_by_key.get(other_keys[0])
        if other is not None and other.name.casefold() != seed.name.casefold():
            return f"Because you listen to {seed.name} and {other.name}"
    if seed.play_count > 0:
        return f"Because you listen to {seed.name}"
    return f"Similar to {seed.name} in your library"


def album_key(title: Any, artist: Any) -> str:
    return f"{normalize_name(artist)}\u0000{normalize_name(title)}"


def dedupe_albums(albums: Sequence[Mapping[str, Any]], limit: int = 20) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for album in albums:
        title = str(album.get("title") or "").strip()[:200]
        artist = str(album.get("artist") or "").strip()[:200]
        if not title or not artist:
            continue
        key = album_key(title, artist)
        if key in seen:
            continue
        seen.add(key)
        result.append(dict(album, title=title, artist=artist))
        if len(result) >= limit:
            break
    return result


def select_album_highlights(recommendations: Sequence[Mapping[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    """Pick a varied album strip, preferring artwork and limiting one artist to two."""
    per_artist: Counter[str] = Counter()
    with_art: list[dict[str, Any]] = []
    without_art: list[dict[str, Any]] = []
    for recommendation in recommendations:
        artist = str(recommendation.get("name") or "").strip()
        artist_key = normalize_name(artist)
        for album in recommendation.get("albums") or []:
            if per_artist[artist_key] >= 2:
                break
            item = dict(album)
            item.setdefault("artist", artist)
            if item.get("artwork"):
                with_art.append(item)
            else:
                without_art.append(item)
            per_artist[artist_key] += 1
    combined = dedupe_albums(with_art) + dedupe_albums(without_art)
    return combined[:limit]


def similarity_cache_key(kind: str, seed: Seed) -> str:
    return f"{kind}:{seed.key}"


def fingerprint(seeds: Sequence[Seed], known_keys: Iterable[str], seen_keys: Iterable[str], limit: int) -> str:
    parts = [
        "|".join(
            f"{seed.key}:{seed.play_count}:{seed.recent_rank}:{seed.library_count}:{chr(2).join(seed.sample_tracks)}"
            for seed in seeds
        ),
        "|".join(sorted(set(known_keys))),
        "|".join(sorted(set(seen_keys))),
        str(limit),
    ]
    return hashlib.sha256("\u0001".join(parts).encode("utf-8")).hexdigest()
