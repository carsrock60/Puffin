import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import app


class VideoPipelineTests(unittest.TestCase):
    def setUp(self):
        self.h264_aac = [
            {"codec_type": "video", "codec_name": "h264"},
            {"codec_type": "audio", "codec_name": "aac"},
        ]

    def test_valid_h264_aac_mp4_returns_without_ffmpeg(self):
        path = Path("already-compatible.mp4")
        with patch.object(app, "_media_streams", return_value=self.h264_aac), patch.object(app.subprocess, "run") as run:
            result = app._make_compatible_mp4(path, {})

        self.assertEqual(result, path)
        run.assert_not_called()

    def test_incompatible_codecs_fail_without_reencoding(self):
        path = Path("source.webm")
        incompatible = [
            {"codec_type": "video", "codec_name": "vp9"},
            {"codec_type": "audio", "codec_name": "opus"},
        ]
        with patch.object(app, "_media_streams", return_value=incompatible), patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(app.DownloadFailure, "will not re-encode"):
                app._make_compatible_mp4(path, {})

        run.assert_not_called()

    def test_video_download_merges_directly_to_mp4_and_prefers_compatible_codecs(self):
        options = app._video_format_options()

        self.assertEqual(options[-2:], ["--merge-output-format", "mp4"])
        self.assertNotIn("mkv", options)
        self.assertIn("avc1", options[1])
        self.assertIn("mp4a", options[1])

    def test_video_quality_limits_every_video_format_to_the_selected_height(self):
        for height in (240, 360, 480, 720, 1080, 1440, 2160):
            with self.subTest(height=height):
                selector = app._video_format_options(height)[1]
                combined, separate, fallback = selector.split("/")

                self.assertIn(f"[height={height}]", combined)
                self.assertIn(f"bv[height<={height}]", separate)
                self.assertIn(f"[height<={height}]", fallback)
                self.assertNotIn("bv]", selector)
                self.assertNotIn("b[", selector.replace(combined, "").replace(fallback, ""))

    def test_public_video_job_reports_requested_and_actual_resolution(self):
        job = {
            "id": "test-job",
            "status": "ready",
            "progress": 100,
            "kind": "video",
            "video_height": 2160,
            "actual_video_height": 720,
        }

        public_job = app._public_job(job)

        self.assertEqual(public_job["requested_video_height"], 2160)
        self.assertEqual(public_job["actual_video_height"], 720)

    def test_pi_quality_capabilities_match_all_slider_stops(self):
        self.assertEqual(app.VIDEO_QUALITY_OPTIONS, (240, 360, 480, 720, 1080, 1440, 2160))

    def test_downloaded_video_must_not_exceed_the_selected_maximum(self):
        self.assertEqual(app._verify_video_resolution(240, 240), 240)
        self.assertEqual(app._verify_video_resolution(720, 2160), 720)
        with self.assertRaisesRegex(app.DownloadFailure, "above the requested maximum"):
            app._verify_video_resolution(720, 240)
        with self.assertRaisesRegex(app.DownloadFailure, "could not verify"):
            app._verify_video_resolution(None, 240)

    def test_missing_compatible_formats_has_actionable_error(self):
        message = app._yt_dlp_failure_message(["ERROR: Requested format is not available"], 1)

        self.assertIn("H.264", message)
        self.assertIn("AAC", message)
        self.assertIn("will not re-encode", message)

    def test_rate_limit_lines_are_recognized(self):
        self.assertTrue(app._is_rate_limit_line("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests"))
        self.assertTrue(app._is_rate_limit_line("too many requests"))
        self.assertFalse(app._is_rate_limit_line("ERROR: Private video"))

    def test_rate_limit_failure_is_actionable(self):
        message = app._yt_dlp_failure_message(["ERROR: HTTP Error 429: Too Many Requests"], 1)

        self.assertIn("rate-limited", message)
        self.assertIn("Wait", message)


class JavaScriptRuntimeTests(unittest.TestCase):
    def test_every_detected_runtime_is_passed_to_yt_dlp(self):
        runtimes = [("deno", Path("/home/pi/.deno/bin/deno")), ("node", Path("/usr/bin/node"))]
        with patch.object(app, "_find_js_runtimes", return_value=runtimes), patch.object(
            app, "_yt_dlp_supports_js_runtimes", return_value=True
        ):
            self.assertEqual(
                app._js_runtime_arguments(),
                [
                    "--js-runtimes", "deno:/home/pi/.deno/bin/deno",
                    "--js-runtimes", "node:/usr/bin/node",
                ],
            )

    def test_node_is_enough_without_deno(self):
        runtimes = [("node", Path("/usr/bin/node"))]
        with patch.object(app, "_find_js_runtimes", return_value=runtimes), patch.object(
            app, "_yt_dlp_supports_js_runtimes", return_value=True
        ):
            self.assertEqual(app._js_runtime_arguments(), ["--js-runtimes", "node:/usr/bin/node"])

    def test_no_runtime_argument_without_any_runtime(self):
        with patch.object(app, "_find_js_runtimes", return_value=[]), patch.object(
            app, "_yt_dlp_supports_js_runtimes", return_value=True
        ):
            self.assertEqual(app._js_runtime_arguments(), [])

    def test_no_runtime_argument_on_old_yt_dlp(self):
        with patch.object(app, "_find_js_runtimes", return_value=[("node", Path("/usr/bin/node"))]), patch.object(
            app, "_yt_dlp_supports_js_runtimes", return_value=False
        ):
            self.assertEqual(app._js_runtime_arguments(), [])

    def test_runtime_directories_are_added_to_the_yt_dlp_path(self):
        runtimes = [("node", Path("/usr/bin/node")), ("quickjs", Path("/usr/local/bin/qjs"))]
        with patch.object(app, "_find_js_runtimes", return_value=runtimes), patch.dict(
            app.os.environ, {"PATH": "/bin"}
        ):
            path = app._yt_dlp_environment()["PATH"]

        self.assertTrue(path.startswith("/usr/bin:/usr/local/bin:"))

    def test_configured_runtimes_override_autodetection(self):
        with tempfile.TemporaryDirectory() as directory:
            node = Path(directory) / "node"
            node.write_text("#!/bin/sh\n", encoding="utf-8")
            node.chmod(0o755)
            with patch.dict(app.os.environ, {"PUFFIN_JS_RUNTIMES": f"node:{node}"}, clear=False), patch.object(
                app, "_find_runtime", side_effect=AssertionError("autodetection should not run")
            ):
                self.assertEqual(app._find_js_runtimes(), [("node", node)])

    def test_unknown_configured_runtime_is_ignored(self):
        with patch.dict(app.os.environ, {"PUFFIN_JS_RUNTIMES": "carrot:/usr/bin/carrot"}, clear=False):
            self.assertEqual(app._find_js_runtimes(), [])

    def test_failure_message_explains_32_bit_options_when_no_runtime_is_found(self):
        with patch.object(app, "_find_js_runtimes", return_value=[]):
            message = app._yt_dlp_failure_message(["ERROR: No supported JavaScript runtime found"], 1)

        self.assertIn("Node.js", message)
        self.assertIn("32-bit", message)
        self.assertIn("PUFFIN_JS_RUNTIMES", message)

    def test_failure_message_points_to_updates_when_a_runtime_is_present(self):
        with patch.object(app, "_find_js_runtimes", return_value=[("node", Path("/usr/bin/node"))]):
            message = app._yt_dlp_failure_message(["ERROR: No supported JavaScript runtime found"], 1)

        self.assertIn("node at /usr/bin/node", message)
        self.assertIn("requirements", message)
        self.assertNotIn("could not find", message)



class SubtitleSelectionTests(unittest.TestCase):
    def test_subtitle_language_is_read_from_the_sidecar_name(self):
        self.assertEqual(app._subtitle_language_from_path(Path("Video [id].fr-CA.vtt")), "fr-CA")
        self.assertEqual(app._subtitle_language_from_path(Path("Video [id].en-orig.vtt")), "en-orig")

    def test_browser_language_is_preferred_then_english_is_the_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            french = root / "Video.fr.vtt"
            canadian_french = root / "Video.fr-CA.vtt"
            english = root / "Video.en.vtt"
            for path in (french, canadian_french, english):
                path.write_text("WEBVTT\n", encoding="utf-8")

            self.assertEqual(app._choose_subtitle_file([french, english, canadian_french], "fr-CA"), canadian_french)
            self.assertEqual(app._choose_subtitle_file([french, english], "de-DE"), english)

    def test_invalid_preferred_language_falls_back_to_english(self):
        self.assertEqual(app._normalize_subtitle_language("fr-CA"), "fr-CA")
        self.assertEqual(app._normalize_subtitle_language("../tmp"), "en")

    def test_subtitle_downloads_are_limited_to_browser_language_and_english(self):
        self.assertEqual(app._subtitle_language_filter("fr-CA"), "fr-CA,fr-CA.*,fr,fr.*,en,en.*,-live_chat")
        self.assertEqual(app._subtitle_language_filter("en"), "en,en.*,-live_chat")
        self.assertNotIn("all", app._subtitle_language_filter("de"))

    def test_invalid_subtitle_language_filter_uses_english(self):
        self.assertEqual(app._subtitle_language_filter("../tmp"), "en,en.*,-live_chat")


if __name__ == "__main__":
    unittest.main()
