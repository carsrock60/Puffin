"""Unit tests for Discover ranking and normalization policy."""

from __future__ import annotations

import unittest

from recommendations import (
    Candidate,
    apply_artist_info,
    build_seeds,
    clean_tags,
    dedupe_albums,
    fingerprint,
    is_uuid,
    merge_similarities,
    normalize_name,
    rank_candidates,
    recommendation_reason,
    select_album_highlights,
)


def seed(name: str, play: int = 0, library: int = 1, recent: int | None = None, tracks=()):
    return {
        "name": name,
        "play_count": play,
        "library_count": library,
        "recent_rank": recent,
        "sample_tracks": list(tracks),
    }


class SeedTests(unittest.TestCase):
    def test_normalizes_and_merges_duplicate_seed_names(self):
        seeds = build_seeds([
            seed("Björk", 1, 1, 4, ["Jóga", "Jóga", "Army of Me"]),
            seed("BJORK", 5, 3, 1, ["Hidden Place"]),
            seed("   ", 9),
        ])

        self.assertEqual(len(seeds), 1)
        item = seeds[0]
        self.assertEqual(item.name, "Björk")
        self.assertEqual(item.play_count, 5)
        self.assertEqual(item.library_count, 3)
        self.assertEqual(item.recent_rank, 1)
        self.assertEqual(item.sample_tracks, ("Jóga", "Army of Me", "Hidden Place"))

    def test_orders_stronger_seeds_first_and_caps_at_ten(self):
        seeds = build_seeds([seed(f"Artist {index}", index, 1, index) for index in range(14)])

        self.assertEqual(len(seeds), 10)
        self.assertGreater(seeds[0].weight, seeds[-1].weight)
        self.assertEqual([item.name for item in seeds[:3]], ["Artist 13", "Artist 12", "Artist 11"])

    def test_name_normalization_is_case_and_accent_insensitive(self):
        self.assertEqual(normalize_name("  Björk & The—Extras "), "bjork and the extras")
        self.assertEqual(normalize_name("AC/DC"), "ac dc")


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.seeds = build_seeds([seed("A", 8, 4, 0), seed("B", 2, 2, 8)])
        self.a, self.b = (item.key for item in self.seeds)

    def test_excludes_known_artists_and_seeds(self):
        candidates = merge_similarities(
            self.seeds,
            {self.a: [{"name": "Known", "match": 0.9}, {"name": "B", "match": 0.8}, {"name": "New", "match": 0.7}]},
            {},
            {normalize_name("Known")},
        )

        self.assertEqual([item.name for item in candidates], ["New"])

    def test_boosts_candidates_supported_by_multiple_seeds(self):
        candidates = merge_similarities(
            self.seeds,
            {
                self.a: [{"name": "Shared", "match": 0.8}, {"name": "Only A", "match": 0.7}],
                self.b: [{"name": "shared", "match": 0.6}],
            },
            {},
            set(),
        )
        shared = next(item for item in candidates if item.name == "Shared")

        self.assertEqual(shared.support, 2)
        self.assertEqual(shared.best_seed_key, self.a)
        self.assertGreater(shared.relevance, 0.75)
        self.assertEqual(candidates[0].name, "Shared")

    def test_track_similarity_contributes_less_than_artist_similarity(self):
        candidates = merge_similarities(
            self.seeds,
            {self.a: [{"name": "Artist pick", "match": 0.5}]},
            {self.a: [{"name": "Track pick", "match": 0.6, "track_title": "Song"}]},
            set(),
        )
        by_name = {item.name: item for item in candidates}

        self.assertGreater(by_name["Artist pick"].relevance, by_name["Track pick"].relevance)
        self.assertEqual(by_name["Track pick"].best_source, "track")
        self.assertEqual(by_name["Track pick"].track_titles[self.a], "Song")

    def test_only_keeps_valid_mbids_and_https_urls(self):
        candidates = merge_similarities(
            self.seeds,
            {self.a: [{
                "name": "Safe",
                "match": 0.9,
                "mbid": "11111111-1111-1111-1111-111111111111",
                "url": "https://www.last.fm/music/Safe",
            }, {
                "name": "Unsafe",
                "match": 0.8,
                "mbid": "not-a-uuid",
                "url": "http://example.test/artist",
            }]},
            {},
            set(),
        )
        by_name = {item.name: item for item in candidates}

        self.assertEqual(by_name["Safe"].mbid, "11111111-1111-1111-1111-111111111111")
        self.assertEqual(by_name["Safe"].lastfm_url, "https://www.last.fm/music/Safe")
        self.assertEqual(by_name["Unsafe"].mbid, "")
        self.assertEqual(by_name["Unsafe"].lastfm_url, "")
        self.assertTrue(is_uuid("11111111-1111-1111-1111-111111111111"))
        self.assertFalse(is_uuid("1111"))

    def test_applies_clean_artist_info(self):
        candidates = merge_similarities(self.seeds, {self.a: [{"name": "New", "match": 0.7}]}, {}, set())
        apply_artist_info(candidates, {candidates[0].key: {
            "mbid": "22222222-2222-2222-2222-222222222222",
            "tags": ["Ambient", "seen live", "ambient", "Piano"],
            "image": "https://img.example.test/artist.jpg",
            "url": "https://www.last.fm/music/New",
            "listeners": 1200,
            "playcount": 9000,
        }})

        item = candidates[0]
        self.assertEqual(item.mbid, "22222222-2222-2222-2222-222222222222")
        self.assertEqual(item.tags, ["ambient", "piano"])
        self.assertEqual(item.lastfm_image, "https://img.example.test/artist.jpg")
        self.assertEqual(item.info_listeners, 1200)

    def test_clean_tags_blocks_noise_and_caps(self):
        self.assertEqual(clean_tags(["seen live", "Ambient", "ambient", "Piano", "Jazz"], 3), ["ambient", "piano", "jazz"])


class RankingTests(unittest.TestCase):
    def test_spaces_out_overlapping_tags_and_respects_source_cap(self):
        seeds = build_seeds([seed("A", 8, 4, 0), seed("B", 2, 2, 8)])
        a, b = (item.key for item in seeds)
        candidates = merge_similarities(
            seeds,
            {
                a: [
                    {"name": "Ambient One", "match": 0.9},
                    {"name": "Ambient Two", "match": 0.85},
                    {"name": "Ambient Three", "match": 0.8},
                ],
                b: [{"name": "Jazz One", "match": 0.8}, {"name": "Ambient Four", "match": 0.7}],
            },
            {},
            set(),
        )
        tags = {
            "Ambient One": ["ambient"],
            "Ambient Two": ["ambient"],
            "Ambient Three": ["ambient"],
            "Jazz One": ["jazz"],
            "Ambient Four": ["ambient"],
        }
        for item in candidates:
            item.tags = tags[item.name]

        selected = rank_candidates(candidates, [a, b], limit=4, max_per_seed=2)
        names = [item.name for item in selected]

        self.assertEqual(len(selected), 4)
        self.assertIn("Jazz One", names)
        self.assertLessEqual(sum(1 for item in selected if item.best_seed_key == a), 2)
        self.assertEqual(names[0], "Ambient One")

    def test_seen_artists_are_penalized_but_can_still_fill_a_list(self):
        seeds = build_seeds([seed("A", 8, 4, 0)])
        a = seeds[0].key
        candidates = merge_similarities(
            seeds,
            {a: [{"name": "Seen", "match": 0.9}, {"name": "Fresh", "match": 0.5}]},
            {},
            set(),
        )

        selected = rank_candidates(candidates, [a], limit=2, seen_keys={normalize_name("Seen")})
        self.assertEqual([item.name for item in selected], ["Fresh", "Seen"])

    def test_reason_explains_the_strongest_seed(self):
        seeds = build_seeds([seed("A", 4), seed("B", 2)])
        by_key = {item.key: item for item in seeds}
        candidate = Candidate(name="New", key="new", sources={seeds[0].key: 1.0, seeds[1].key: 0.4})

        self.assertEqual(recommendation_reason(candidate, by_key), "Because you listen to A and B")
        self.assertEqual(recommendation_reason(Candidate("New", "new", sources={seeds[0].key: 1.0}), by_key), "Because you listen to A")
        library_only = build_seeds([seed("C", 0)])
        self.assertEqual(
            recommendation_reason(Candidate("New", "new", sources={library_only[0].key: 1.0}), {library_only[0].key: library_only[0]}),
            "Similar to C in your library",
        )


class AlbumTests(unittest.TestCase):
    def test_dedupes_albums_by_normalized_title_and_artist(self):
        albums = dedupe_albums([
            {"title": "One", "artist": "A", "artwork": "https://a/1"},
            {"title": " one ", "artist": "a", "artwork": "https://a/2"},
            {"title": "", "artist": "A"},
        ])

        self.assertEqual(len(albums), 1)
        self.assertEqual(albums[0]["artwork"], "https://a/1")

    def test_album_highlights_prefer_artwork_and_limit_each_artist(self):
        recommendations = [
            {"name": "A", "albums": [
                {"title": "No Art", "artwork": ""},
                {"title": "With Art", "artwork": "https://a/1"},
                {"title": "Third", "artwork": "https://a/2"},
            ]},
            {"name": "B", "albums": [{"title": "B Art", "artwork": "https://b/1"}]},
        ]
        highlights = select_album_highlights(recommendations, limit=10)

        self.assertEqual([item["title"] for item in highlights], ["With Art", "B Art", "No Art"])
        self.assertEqual(highlights[0]["artist"], "A")


class FingerprintTests(unittest.TestCase):
    def test_fingerprint_changes_with_seed_history_or_limit(self):
        seeds = build_seeds([seed("A", 1), seed("B", 2)])
        first = fingerprint(seeds, {"one"}, {"seen"}, 16)

        self.assertEqual(first, fingerprint(seeds, ["one"], ["seen"], 16))
        self.assertNotEqual(first, fingerprint(seeds, {"one"}, {"seen"}, 12))
        self.assertNotEqual(first, fingerprint(seeds, {"one", "two"}, {"seen"}, 16))
        self.assertNotEqual(first, fingerprint(seeds, {"one"}, {"seen", "other"}, 16))
        with_tracks = build_seeds([seed("A", 1, tracks=["Says"]), seed("B", 2)])
        self.assertNotEqual(first, fingerprint(with_tracks, {"one"}, {"seen"}, 16))


if __name__ == "__main__":
    unittest.main()
