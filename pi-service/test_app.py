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

    def test_missing_compatible_formats_has_actionable_error(self):
        message = app._yt_dlp_failure_message(["ERROR: Requested format is not available"], 1)

        self.assertIn("H.264", message)
        self.assertIn("AAC", message)
        self.assertIn("will not re-encode", message)


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


if __name__ == "__main__":
    unittest.main()
