"""End-to-end pipeline test using an in-memory provider double."""

from __future__ import annotations

import unittest

import main
from providers import TTLCache


def uid(index: int) -> str:
    return f"00000000-0000-0000-0000-{index:012d}"


class FakeProviders:
    def __init__(self):
        self.cache = TTLCache()

    async def artist_similar(self, seed):
        hits = {
            "nils frahm": [("Beach House", 0.92), ("Hania Rani", 0.88), ("Known Artist", 0.99)],
            "hania rani": [("Beach House", 0.84), ("Ólafur Arnalds", 0.81)],
        }
        return [
            {"name": name, "mbid": "", "match": match, "url": ""}
            for name, match in hits.get(seed.key, [])
        ]

    async def track_similar(self, seed):
        return [{"name": "Jon Hopkins", "mbid": "", "match": 0.77, "url": ""}]

    async def artist_infos(self, names):
        return {
            main.ranking.normalize_name(name): {
                "name": name,
                "mbid": uid(10),
                "image": f"https://images.example.test/{main.ranking.stable_id(name)}.jpg",
                "tags": ["ambient", "piano"],
                "bio": "A careful, quiet artist.",
                "url": "https://www.last.fm/music/example",
            }
            for name in names
        }

    async def resolve_mbid(self, name):
        return uid(20)

    async def artist_image(self, name, mbid, lastfm_image):
        return {"url": f"https://images.example.test/{mbid}.jpg", "source": "Fanart.tv", "kind": "portrait"}

    async def artist_albums(self, name, mbid, limit):
        return [{
            "title": f"{name} Album",
            "artist": name,
            "year": "2024",
            "artwork": f"https://images.example.test/{main.ranking.stable_id(name)}-album.jpg",
            "releaseGroupId": uid(30),
            "source": "Cover Art Archive",
        }]


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_builds_personalized_artists_and_albums_without_known_seeds(self):
        request = main.RecommendationsRequest(
            artists=[
                main.SeedArtist(name="Nils Frahm", play_count=12, library_count=2, recent_rank=1, sample_tracks=["Says"]),
                main.SeedArtist(name="Hania Rani", play_count=4, library_count=1, recent_rank=4),
            ],
            known_artists=["Known Artist", "Nils Frahm"],
            seen_artists=[],
            limit=16,
        )
        payload = await main._build_recommendations(FakeProviders(), request)
        names = [item["name"] for item in payload["recommendations"]]

        self.assertEqual(payload["status"], "ok")
        self.assertNotIn("Known Artist", names)
        self.assertNotIn("Nils Frahm", names)
        self.assertIn("Beach House", names)
        self.assertIn("Jon Hopkins", names)
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(item["image"].startswith("https://") for item in payload["recommendations"]))
        self.assertTrue(all(item["reason"] for item in payload["recommendations"]))
        self.assertEqual({item["artist"] for item in payload["albums"]}, set(names[:3]))
        self.assertTrue(all(item["artwork"] for item in payload["albums"]))
        self.assertFalse(payload["partial"])

    async def test_empty_similarity_set_is_an_empty_not_an_error(self):
        class EmptyProviders(FakeProviders):
            async def artist_similar(self, seed):
                return []

            async def track_similar(self, seed):
                return []

        request = main.RecommendationsRequest(artists=[main.SeedArtist(name="Nils Frahm")])
        payload = await main._build_recommendations(EmptyProviders(), request)
        self.assertEqual(payload["status"], "empty")
        self.assertEqual(payload["recommendations"], [])


if __name__ == "__main__":
    unittest.main()
