import unittest
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


if __name__ == "__main__":
    unittest.main()
