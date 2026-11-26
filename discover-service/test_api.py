"""API-level tests for the Discover service safe unconfigured state."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import main


class UnconfiguredApiTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict("os.environ", {"LASTFM_API_KEY": "", "FANART_API_KEY": ""})
        self.env.start()
        self.client = TestClient(main.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()

    def test_health_reports_missing_credentials_without_exposing_them(self):
        response = self.client.get("/api/discover/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertFalse(data["configured"]["lastfm"])
        self.assertFalse(data["configured"]["fanart"])
        self.assertNotIn("LASTFM_API_KEY", response.text)

    def test_recommendations_are_calm_when_lastfm_is_not_configured(self):
        response = self.client.post("/api/discover/recommendations", json={
            "artists": [{"name": "Nils Frahm", "library_count": 2}],
            "known_artists": ["Nils Frahm"],
            "seen_artists": [],
            "limit": 16,
        })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "unconfigured")
        self.assertEqual(data["recommendations"], [])
        self.assertEqual(data["albums"], [])
        self.assertIn("not configured", data["message"])

    def test_request_validation_caps_seed_count(self):
        response = self.client.post("/api/discover/recommendations", json={
            "artists": [{"name": "Artist " + str(index)} for index in range(11)],
        })
        self.assertEqual(response.status_code, 422)

    def test_blank_artist_detail_is_rejected_without_network_access(self):
        response = self.client.get("/api/discover/artist", params={"name": "   "})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["status"], "error")


if __name__ == "__main__":
    unittest.main()
