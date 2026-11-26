"""Focused tests for Discover provider normalization and caching."""

from __future__ import annotations

import asyncio
import unittest

import httpx

from providers import (
    DiscoveryProviders,
    ProviderError,
    RateLimitError,
    TTLCache,
    _strip_html,
    filter_itunes_albums,
    filter_release_groups,
    find_itunes_album_art,
    itunes_album_art_map,
    itunes_artwork,
    select_fanart_image,
    select_lastfm_image,
)

PLACEHOLDER = "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png"


class ArtworkSelectionTests(unittest.TestCase):
    def test_lastfm_image_skips_placeholder_and_upgrades_http(self):
        images = [
            {"size": "mega", "#text": PLACEHOLDER},
            {"size": "large", "#text": "http://img.example.test/artist.jpg"},
            {"size": "small", "#text": "https://img.example.test/small.jpg"},
        ]
        self.assertEqual(select_lastfm_image(images), "https://img.example.test/artist.jpg")

    def test_lastfm_image_returns_empty_for_only_placeholders(self):
        self.assertEqual(select_lastfm_image([{"size": "mega", "#text": PLACEHOLDER}]), "")

    def test_fanart_prefers_real_portrait_and_rejects_small_or_foreign_images(self):
        payload = {
            "artistbackground": [{"url": "https://assets.fanart.tv/bg.jpg", "width": 1920, "height": 1080, "likes": 9}],
            "artistthumb": [
                {"url": "https://assets.fanart.tv/tiny.jpg", "width": 200, "height": 200, "likes": 99},
                {"url": "https://evil.test/fake.jpg", "width": 1000, "height": 1000, "likes": 99},
                {"url": "https://evilfanart.tv/fake.jpg", "width": 1000, "height": 1000, "likes": 99},
                {"url": "https://assets.fanart.tv/portrait.jpg", "width": 1000, "height": 1000, "likes": 4},
            ],
        }
        selected = select_fanart_image(payload)
        self.assertEqual(selected["url"], "https://assets.fanart.tv/portrait.jpg")
        self.assertEqual(selected["source"], "Fanart.tv")

    def test_fanart_falls_back_to_background(self):
        payload = {"artistbackground": [{"url": "https://assets.fanart.tv/bg.jpg", "width": 1400, "height": 900}]}
        selected = select_fanart_image(payload)
        self.assertEqual(selected["kind"], "background")

    def test_itunes_artwork_uses_a_large_cover(self):
        self.assertEqual(
            itunes_artwork("https://is1-ssl.mzstatic.com/image/thumb/Music/abc/100x100bb.jpg"),
            "https://is1-ssl.mzstatic.com/image/thumb/Music/abc/600x600bb.jpg",
        )


class AlbumNormalizationTests(unittest.TestCase):
    def test_release_groups_exclude_live_and_duplicate_editions(self):
        groups = [
            {"id": "11111111-1111-1111-1111-111111111111", "title": "Spaces", "primary-type": "Album", "first-release-date": "2013-01-01"},
            {"id": "22222222-2222-2222-2222-222222222222", "title": "Spaces", "primary-type": "Album", "first-release-date": "2014-01-01"},
            {"id": "33333333-3333-3333-3333-333333333333", "title": "Live in Berlin", "primary-type": "Album", "secondary-types": ["Live"], "first-release-date": "2020-01-01"},
            {"id": "44444444-4444-4444-4444-444444444444", "title": "All Melody", "primary-type": "Album", "first-release-date": "2018-01-01"},
        ]
        albums = filter_release_groups(groups)
        self.assertEqual([album["title"] for album in albums], ["All Melody", "Spaces"])

    def test_itunes_album_map_is_artist_specific(self):
        results = [
            {"collectionType": "album", "collectionArtistName": "Nils Frahm", "collectionName": "Spaces", "artworkUrl100": "https://img.test/100x100bb.jpg"},
            {"collectionType": "album", "collectionArtistName": "Someone Else", "collectionName": "Spaces", "artworkUrl100": "https://img.test/other.jpg"},
            {"collectionType": "album", "collectionArtistName": "Nils Frahm", "collectionName": "Spaces (Deluxe)", "artworkUrl100": "https://img.test/deluxe.jpg"},
        ]
        mapped = itunes_album_art_map(results, "Nils Frahm")
        self.assertEqual(list(mapped), ["spaces", "spaces deluxe"])
        self.assertEqual(find_itunes_album_art("Nils Frahm", "Spaces", mapped), "https://img.test/600x600bb.jpg")
        self.assertEqual(find_itunes_album_art("Nils Frahm", "Spaces Remixed", mapped), "")
        self.assertEqual(
            find_itunes_album_art("Nils Frahm", "Spaces", {"spaces deluxe": "https://img.test/deluxe.jpg"}),
            "https://img.test/deluxe.jpg",
        )

    def test_itunes_albums_only_include_exact_artist_albums(self):
        results = [
            {"collectionType": "album", "collectionArtistName": "Hania Rani", "collectionName": "Esja", "releaseDate": "2019-01-01", "artworkUrl100": "https://img.test/esja/100x100bb.jpg"},
            {"collectionType": "album", "collectionArtistName": "Hania Rani", "collectionName": "Esja", "releaseDate": "2020-01-01"},
            {"collectionType": "single", "collectionArtistName": "Hania Rani", "collectionName": "Single", "releaseDate": "2021-01-01"},
            {"collectionType": "album", "collectionArtistName": "Hania", "collectionName": "Home", "releaseDate": "2020-01-01"},
        ]
        albums = filter_itunes_albums(results, "Hania Rani")
        self.assertEqual([album["title"] for album in albums], ["Esja"])
        self.assertEqual(albums[0]["year"], "2019")

    def test_strip_html_decodes_entities_and_removes_lastfm_footer(self):
        value = "<p>Tom &amp; Jerry&#39;s quiet piano.</p> <a href=\"https://last.fm\">Read more on Last.fm</a>"
        self.assertEqual(_strip_html(value), "Tom & Jerry's quiet piano.")


class CacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_negative_and_single_flight_cache(self):
        cache = TTLCache()
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return []

        results = await asyncio.gather(*[cache.get_or_create("missing", 60, factory, negative_ttl=5) for _ in range(4)])
        self.assertEqual(results, [[], [], [], []])
        self.assertEqual(calls, 1)


class RequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.provider = DiscoveryProviders()
        await self.provider._client.aclose()

    async def asyncTearDown(self):
        await self.provider._client.aclose()

    async def test_request_retries_transient_server_error(self):
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(503 if calls == 1 else 200, json={"ok": True})

        self.provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        response = await self.provider._request("GET", "https://example.test", provider="Test")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, 2)

    async def test_request_surfaces_rate_limit_with_retry_after(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, headers={"Retry-After": "7"})

        self.provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with self.assertRaises(RateLimitError) as raised:
            await self.provider._request("GET", "https://example.test", provider="Test")
        self.assertEqual(raised.exception.retry_after, 7.0)

    async def test_request_converts_transport_failure(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        self.provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with self.assertRaises(ProviderError):
            await self.provider._request("GET", "https://example.test", provider="Test")


if __name__ == "__main__":
    unittest.main()
