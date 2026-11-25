"""Private, job-based downloader API for Puffin."""

from __future__ import annotations

import functools
import json
import logging
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit


HOST = "127.0.0.1"
PORT = int(os.environ.get("PUFFIN_PORT", "8765"))
DOWNLOAD_DIR = Path(os.environ.get("PUFFIN_DOWNLOAD_DIR", "~/puffin-downloads")).expanduser()
MAX_DOWNLOAD_BYTES = int(os.environ.get("PUFFIN_MAX_DOWNLOAD_BYTES", str(2 * 1024**3)))
MIN_FREE_BYTES = int(os.environ.get("PUFFIN_MIN_FREE_BYTES", str(1024**3)))
JOB_RETENTION_SECONDS = int(os.environ.get("PUFFIN_JOB_RETENTION_SECONDS", "3600"))
YTDLP_STALL_SECONDS = int(os.environ.get("PUFFIN_YTDLP_STALL_SECONDS", "180"))
YTDLP_SOCKET_TIMEOUT = int(os.environ.get("PUFFIN_YTDLP_SOCKET_TIMEOUT", "20"))
SUBTITLE_TIMEOUT_SECONDS = int(os.environ.get("PUFFIN_SUBTITLE_TIMEOUT_SECONDS", "45"))
VIDEO_QUALITY_OPTIONS = (240, 360, 480, 720, 1080, 1440, 2160)
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("PUFFIN_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
}

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.RLock()
PROGRESS_PATTERN = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
SPEED_PATTERN = re.compile(r"\bat\s+([0-9.]+\s*[KMG]?i?B/s)")
ETA_PATTERN = re.compile(r"\bETA\s+(\d{2}:\d{2}(?::\d{2})?)")
RATE_LIMIT_MESSAGE = (
    "YouTube rate-limited the Pi, so Puffin stopped retrying instead of leaving the download hanging. "
    "Wait several minutes before trying again, and avoid starting several downloads or searches in a row. "
    "If it keeps happening, the Pi's network address is being throttled by YouTube."
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("puffin-downloader")
AUDIO_MIME_TYPES = {
    "aac": "audio/aac",
    "aiff": "audio/aiff",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
    "mp3": "audio/mpeg",
    "oga": "audio/ogg",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "webm": "audio/webm",
}
SUPPORTED_AUDIO_EXTENSIONS = set(AUDIO_MIME_TYPES)


class DownloadFailure(Exception):
    """A download or conversion failed for a known, user-actionable reason."""


def _system_tool(name: str) -> str:
    """Resolve Pi system tools even when systemd has a restricted PATH."""
    return shutil.which(name) or str(Path("/usr/bin") / name)


def _yt_dlp_command(*arguments: str) -> list[str]:
    # Use the exact interpreter running this service. systemd does not
    # activate the virtual environment's bin directory in PATH.
    return [sys.executable, "-m", "yt_dlp", *_js_runtime_arguments(), *arguments]


JS_RUNTIME_NAMES = ("deno", "node", "quickjs", "bun")
JS_RUNTIME_BINARIES = {
    "deno": ("deno",),
    "node": ("node",),
    "quickjs": ("qjs", "quickjs"),
    "bun": ("bun",),
}
JS_RUNTIME_DIRECTORIES = (
    Path.home() / ".deno" / "bin",
    Path.home() / ".bun" / "bin",
    Path.home() / ".local" / "bin",
    Path("/usr/local/bin"),
    Path("/usr/bin"),
    Path("/opt/homebrew/bin"),
)


def _is_executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def _find_runtime(name: str) -> Path | None:
    for binary_name in JS_RUNTIME_BINARIES[name]:
        found = shutil.which(binary_name)
        if found:
            return Path(found)
        for directory in JS_RUNTIME_DIRECTORIES:
            candidate = directory / binary_name
            if _is_executable(candidate):
                return candidate
    return None


def _find_js_runtimes() -> list[tuple[str, Path]]:
    """Locate the JavaScript runtimes yt-dlp can use for YouTube challenges.

    Deno and Bun publish no 32-bit ARM builds, so 32-bit Raspberry Pi
    installations typically use Node.js or QuickJS instead. yt-dlp accepts
    deno, node, quickjs, and bun in that order of preference.
    """
    override = os.environ.get("PUFFIN_JS_RUNTIMES", "").strip()
    if not override:
        deno_override = os.environ.get("PUFFIN_DENO_PATH", "").strip()
        if deno_override:
            override = f"deno:{deno_override}"
    if override:
        runtimes = []
        for entry in override.split(","):
            name, _, path = entry.strip().partition(":")
            name = name.strip().lower()
            if name not in JS_RUNTIME_NAMES:
                LOGGER.warning("Ignoring unknown JavaScript runtime %r in PUFFIN_JS_RUNTIMES", name)
                continue
            binary = Path(path).expanduser() if path.strip() else _find_runtime(name)
            if binary is not None and _is_executable(binary):
                runtimes.append((name, binary))
            else:
                LOGGER.warning("Configured JavaScript runtime %s was not found or is not executable", name)
        return runtimes
    runtimes = []
    for name in JS_RUNTIME_NAMES:
        binary = _find_runtime(name)
        if binary is not None:
            runtimes.append((name, binary))
    return runtimes


def _yt_dlp_environment() -> dict[str, str]:
    env = dict(os.environ)
    directories = [str(binary.parent) for _, binary in _find_js_runtimes()]
    env["PATH"] = os.pathsep.join(filter(None, [*directories, env.get("PATH", "")]))
    # Emit download progress as it happens even though stdout is a pipe;
    # otherwise a working download can look stalled at 0%.
    env["PYTHONUNBUFFERED"] = "1"
    return env


@functools.lru_cache(maxsize=1)
def _yt_dlp_supports_js_runtimes() -> bool:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "--help"],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return "--js-runtimes" in (result.stdout or "")


def _js_runtime_arguments() -> list[str]:
    runtimes = _find_js_runtimes()
    if not runtimes or not _yt_dlp_supports_js_runtimes():
        return []
    arguments = []
    for name, binary in runtimes:
        arguments.extend(["--js-runtimes", f"{name}:{binary}"])
    return arguments


def _signal_process_group(process: subprocess.Popen, force: bool = False) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill() if force else process.terminate()
        except ProcessLookupError:
            pass


def _terminate_process_group(process: subprocess.Popen) -> None:
    _signal_process_group(process)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _signal_process_group(process, force=True)
        process.wait()


def _safe_diagnostic(line: str) -> str:
    line = re.sub(r"https?://\S+", "[URL]", line)
    return " ".join(line.split())[:240]


def _is_rate_limit_line(line: str) -> bool:
    lowered = line.lower()
    return "http error 429" in lowered or "too many requests" in lowered


def _yt_dlp_failure_message(lines: list[str], return_code: int) -> str:
    output = "\n".join(lines)
    lowered = output.lower()
    if "no module named yt_dlp" in lowered:
        return "yt-dlp is missing from the service virtual environment. Run pip install -r requirements.txt and restart the Pi service."
    if "requested format is not available" in lowered:
        return "This video does not offer H.264 video with AAC audio. Puffin will not re-encode it on the Pi; choose another video."
    if any(term in lowered for term in ("javascript runtime", "javascript challenge", "yt-dlp-ejs", "[jsc]", "failed to decrypt", "nsig")):
        runtimes = _find_js_runtimes()
        if not runtimes:
            return (
                "YouTube needs an external JavaScript runtime to solve its challenge, but the Pi service "
                "could not find Deno, Node.js, QuickJS, or Bun. Deno has no 32-bit build: on 32-bit Raspberry "
                "Pi OS install Node.js 22+ or QuickJS, then set PUFFIN_JS_RUNTIMES=node:/path/to/node (or "
                "quickjs:/path/to/qjs) in /etc/puffin-downloader.env and restart the service. "
                "See pi-service/README.md."
            )
        found = ", ".join(f"{name} at {binary}" for name, binary in runtimes)
        return (
            f"YouTube's JavaScript challenge solver failed even though the Pi service found {found}. "
            "Update the Pi service requirements (pip install -U -r requirements.txt) so yt-dlp and "
            "yt-dlp-ejs are current, then restart the service."
        )
    if "http error 429" in lowered or "too many requests" in lowered:
        return "YouTube temporarily rate-limited the Pi. Wait a little and retry."
    if "sign in to confirm" in lowered or "private video" in lowered or "requires authentication" in lowered:
        return "This video requires sign-in or is not publicly available."

    for line in reversed(lines):
        if "error:" in line.lower():
            return f"yt-dlp failed: {_safe_diagnostic(line)}"
    return f"yt-dlp exited with code {return_code}. Check the Pi service logs for details."


def _is_allowed_media_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 4096:
        return False
    if value.startswith(("ytsearch:", "ytsearch1:")):
        query = value.split(":", 1)[1].strip()
        return bool(query) and len(query) <= 1000 and not any(ord(character) < 32 for character in query)
    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError:
        return False

    youtube_host = hostname == "youtu.be" or hostname == "youtube.com" or hostname.endswith(".youtube.com")
    return parsed.scheme == "https" and port in {None, 443} and not parsed.username and not parsed.password and youtube_host


def _safe_filename(path: Path) -> str:
    name = path.name.replace("\r", "").replace("\n", "").replace('"', "'")
    return name or "puffin-media"


def _subtitle_language_from_path(path: Path) -> str:
    language = path.stem.rsplit(".", 1)[-1]
    if not re.fullmatch(r"[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*", language):
        return "und"
    return language.replace("_", "-")


def _normalize_subtitle_language(value: object) -> str:
    if isinstance(value, str) and len(value) <= 35 and re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", value.strip()):
        return value.strip().replace("_", "-")
    return "en"


def _choose_subtitle_file(paths: list[Path], preferred_language: str = "en") -> Path | None:
    if not paths:
        return None
    preferred = preferred_language.lower().replace("_", "-")
    preferred_base = preferred.split("-", 1)[0]

    def priority(path: Path) -> tuple[int, str, float, str]:
        language = _subtitle_language_from_path(path).lower()
        if language == preferred:
            language_priority = 0
        elif language == preferred_base or language.startswith(f"{preferred_base}-"):
            language_priority = 1
        elif language == "en":
            language_priority = 2
        elif language.startswith("en-"):
            language_priority = 3
        elif language == "und":
            language_priority = 5
        else:
            language_priority = 4
        return (language_priority, language, -path.stat().st_mtime, path.name.lower())

    return min(paths, key=priority)


def _ensure_supported_audio(path: Path, supported_formats: list[str], job: dict) -> Path:
    extension = path.suffix.lower().lstrip(".")
    if extension in supported_formats and extension in SUPPORTED_AUDIO_EXTENSIONS:
        return path

    output_path = path.with_suffix(".m4a")
    with JOBS_LOCK:
        job["status"] = "converting"
        job["stage"] = "processing"
        job["progress"] = 99
        job["updated_at"] = time.time()

    common_args = [_system_tool("ffmpeg"), "-nostdin", "-y", "-i", str(path), "-vn"]
    copied = subprocess.run(
        [*common_args, "-c:a", "copy", "-movflags", "+faststart", str(output_path)],
        capture_output=True,
        text=True,
    )
    if copied.returncode != 0:
        encoded = subprocess.run(
            [*common_args, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output_path)],
            capture_output=True,
            text=True,
        )
        if encoded.returncode != 0:
            detail = (encoded.stderr or copied.stderr or "").strip().splitlines()
            summary = _safe_diagnostic(detail[-1]) if detail else "ffmpeg returned an error"
            raise DownloadFailure(f"Could not convert this audio to a Puffin-compatible M4A file: {summary}")

    path.unlink(missing_ok=True)
    return output_path


def _media_streams(path: Path) -> list[dict]:
    probe = subprocess.run(
        [
            _system_tool("ffprobe"), "-v", "error",
            "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if probe.returncode != 0:
        return []
    try:
        return json.loads(probe.stdout).get("streams") or []
    except (json.JSONDecodeError, AttributeError):
        return []


def _has_audio_and_video_streams(path: Path) -> bool:
    kinds = {stream.get("codec_type") for stream in _media_streams(path)}
    return {"video", "audio"}.issubset(kinds)


def _make_compatible_mp4(path: Path, job: dict, separate_audio: Path | None = None) -> Path:
    streams = _media_streams(path)
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio_streams = _media_streams(separate_audio) if separate_audio else streams
    audio = next((stream for stream in audio_streams if stream.get("codec_type") == "audio"), None)
    if not video or not audio:
        raise DownloadFailure("The downloaded source is missing its video or audio stream.")
    if video.get("codec_name") != "h264" or audio.get("codec_name") != "aac":
        raise DownloadFailure(
            "This video is not available as H.264 video with AAC audio. Puffin will not re-encode it on the Pi; choose another video."
        )

    output_path = path.with_suffix(".mp4")
    temporary_path = path.with_name(f"{path.stem}.puffin-converting.mp4")
    if not separate_audio and path.suffix.lower() == ".mp4":
        return path

    audio_input_index = 0
    ffmpeg_args = [_system_tool("ffmpeg"), "-nostdin", "-y", "-i", str(path)]
    if separate_audio and separate_audio != path:
        ffmpeg_args.extend(["-i", str(separate_audio)])
        audio_input_index = 1
    ffmpeg_args.extend([
            "-map", "0:v:0", "-map", f"{audio_input_index}:a:0",
            "-c:v", "copy", "-c:a", "copy",
            "-movflags", "+faststart", str(temporary_path),
        ])

    with JOBS_LOCK:
        job["status"] = "converting"
        job["stage"] = "processing"
        job["progress"] = 99
        job["updated_at"] = time.time()
    conversion = subprocess.run(ffmpeg_args, capture_output=True, text=True)
    if conversion.returncode != 0 or not temporary_path.is_file():
        temporary_path.unlink(missing_ok=True)
        detail = (conversion.stderr or "").strip().splitlines()
        summary = _safe_diagnostic(detail[-1]) if detail else "ffmpeg returned an error"
        raise DownloadFailure(f"Could not create the MP4 with video and audio: {summary}")

    if output_path == path:
        temporary_path.replace(path)
    else:
        path.unlink(missing_ok=True)
        temporary_path.replace(output_path)
    if separate_audio and separate_audio != path:
        separate_audio.unlink(missing_ok=True)
    if not _has_audio_and_video_streams(output_path):
        raise DownloadFailure("The converted MP4 is missing its video or audio stream.")
    return output_path


def _video_format_options(height: int = 720) -> list[str]:
    # Prefer a combined MP4 at the requested resolution. If unavailable,
    # choose the best compatible separate streams up to that resolution.
    combined = f"b[ext=mp4][height={height}][vcodec~='^(avc1|h264)'][acodec~='^(mp4a|aac)']"
    separate = f"bv[height<={height}][vcodec~='^(avc1|h264)']+ba[acodec~='^(mp4a|aac)']"
    fallback = f"b[ext=mp4][height<={height}][vcodec~='^(avc1|h264)'][acodec~='^(mp4a|aac)']"
    return [
        "--format",
        f"{combined}/{separate}/{fallback}",
        "--merge-output-format",
        "mp4",
    ]


def _verify_video_resolution(actual_height: object, requested_height: int) -> int:
    if type(actual_height) is not int:
        raise DownloadFailure("The Pi could not verify the downloaded video's resolution.")
    if actual_height > requested_height:
        raise DownloadFailure(
            f"The Pi selected {actual_height}p, above the requested maximum of {requested_height}p."
        )
    return actual_height


def _public_job(job: dict) -> dict:
    public_job = {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "speed": job.get("speed"),
        "eta": job.get("eta"),
        "kind": job["kind"],
        "filename": job.get("filename"),
        "size": job.get("size"),
        "mime_type": job.get("mime_type"),
        "subtitles_available": bool(job.get("subtitle_path")),
        "subtitle_size": job.get("subtitle_size", 0),
        "subtitle_language": job.get("subtitle_language"),
        "stage": job.get("stage"),
        "error": job.get("error"),
    }
    if job.get("kind") == "video":
        public_job["requested_video_height"] = job.get("video_height", 720)
        public_job["actual_video_height"] = job.get("actual_video_height")
    return public_job


def _search_youtube(query: str) -> list[dict]:
    command = _yt_dlp_command(
        "--dump-single-json",
        "--flat-playlist",
        "--skip-download",
        "--no-progress",
        "--no-warnings",
        f"ytsearch10:{query}",
    )
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True, env=_yt_dlp_environment())
    payload = json.loads(result.stdout)
    videos = []
    for entry in payload.get("entries") or []:
        video_id = entry.get("id")
        if not video_id:
            continue
        thumbnails = entry.get("thumbnails") or []
        thumbnail = entry.get("thumbnail") or (thumbnails[-1].get("url") if thumbnails else None)
        videos.append({
            "id": video_id,
            "url": f"https://www.youtube.com/watch?v={quote(str(video_id), safe='')}",
            "title": entry.get("title") or "Untitled video",
            "channel": entry.get("uploader") or entry.get("channel") or "Unknown channel",
            "duration": entry.get("duration"),
            "thumbnail": thumbnail,
        })
        if len(videos) == 10:
            break
    return videos


def _remove_work_directory(job: dict) -> None:
    work_dir = job.get("work_dir")
    if work_dir:
        shutil.rmtree(work_dir, ignore_errors=True)


def _subtitle_language_filter(language: object) -> str:
    """Limit subtitle downloads to the browser language plus English.

    Puffin keeps a single subtitle track, so requesting every available
    language (``--sub-langs all``) makes yt-dlp fetch dozens of translated
    tracks before the job reports anything, which looks like a hang.
    """
    normalized = _normalize_subtitle_language(language)
    base = normalized.split("-", 1)[0]
    languages: list[str] = []
    for value in (normalized, f"{normalized}.*", base, f"{base}.*", "en", "en.*"):
        if value not in languages:
            languages.append(value)
    return ",".join([*languages, "-live_chat"])


def _subtitle_command(job: dict, work_dir: Path, info_json: Path) -> list[str]:
    """Build a subtitle-only pass that reuses the media download's metadata.

    Downloading subtitles inside the media command makes yt-dlp fetch them
    before the media transfer starts, which is slow on a Pi and looks like a
    stuck download. Loading the saved info JSON avoids re-extracting (and
    re-solving YouTube's challenge) for this pass.
    """
    return _yt_dlp_command(
        "--skip-download",
        "--load-info-json",
        str(info_json),
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        _subtitle_language_filter(job.get("preferred_subtitle_language", "en")),
        "--sub-format",
        "vtt/best",
        "--convert-subs",
        "vtt",
        "--no-progress",
        "--no-warnings",
        "--output",
        str(work_dir / "%(title).160s [%(id)s].%(ext)s"),
    )


def _download_subtitles(job: dict, work_dir: Path) -> None:
    info_json = next((path for path in work_dir.iterdir() if path.name.endswith(".info.json")), None)
    if info_json is None:
        LOGGER.info("Video download job %s has no info JSON; skipping subtitles", job["id"])
        return
    try:
        subtitle_started = time.monotonic()
        result = subprocess.run(
            _subtitle_command(job, work_dir, info_json),
            capture_output=True,
            text=True,
            timeout=SUBTITLE_TIMEOUT_SECONDS,
            env=_yt_dlp_environment(),
        )
        LOGGER.info(
            "Subtitle pass for job %s finished in %.1fs (exit %s)",
            job["id"],
            time.monotonic() - subtitle_started,
            result.returncode,
        )
    except (OSError, subprocess.SubprocessError) as error:
        LOGGER.warning("Subtitle download for job %s failed: %s", job["id"], type(error).__name__)
        return
    if result.returncode != 0:
        detail = _safe_diagnostic((result.stderr or "").strip().splitlines()[-1]) if result.stderr else "no output"
        LOGGER.warning("Subtitle download for job %s exited %s: %s", job["id"], result.returncode, detail)


def _run_download_worker(job_id: str) -> None:
    """Never leave a job stuck in a running state if the worker crashes."""
    try:
        _run_download(job_id)
    except Exception:
        LOGGER.exception("Download worker for job %s crashed", job_id)
        _fail_job(job_id, "The Pi downloader stopped unexpectedly. Restart the service and try again.")


def _run_download(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        if job["cancel_requested"]:
            job["status"] = "cancelled"
            job["stage"] = "cancelled"
            job["worker_active"] = False
            job["updated_at"] = time.time()
            _remove_work_directory(job)
            return
        job["status"] = "downloading"
        job["stage"] = "resolving"
        job["updated_at"] = time.time()

    work_dir = Path(job["work_dir"])
    output_template = str(work_dir / "%(title).160s [%(id)s].%(ext)s")
    command = _yt_dlp_command(
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-write-thumbnail",
        "--no-overwrites",
        "--socket-timeout",
        str(YTDLP_SOCKET_TIMEOUT),
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--retry-sleep",
        "http:exp=1:8",
        "--retry-sleep",
        "fragment:exp=1:8",
        "--retry-sleep",
        "extractor:exp=1:8",
        "--extractor-retries",
        "2",
        "--max-filesize",
        str(MAX_DOWNLOAD_BYTES),
        "--output",
        output_template,
    )

    if job["kind"] == "audio":
        command.extend([
            "--format",
            "bestaudio",
        ])
    else:
        command.extend([
            "--write-info-json",
        ])
        command.extend(_video_format_options(job.get("video_height", 720)))
    command.append(job["url"])

    process = None
    compatible_format_missing = False
    output_tail = []
    stalled = False
    rate_limited = False
    rate_limit_hits = 0
    started_at = time.monotonic()
    first_progress_logged = [False]
    last_output_at = [time.monotonic()]

    def stop_stalled_download() -> None:
        nonlocal stalled
        while process is not None and process.poll() is None:
            time.sleep(2)
            if time.monotonic() - last_output_at[0] <= YTDLP_STALL_SECONDS:
                continue
            stalled = True
            LOGGER.warning(
                "Download job %s produced no output for %s seconds; stopping yt-dlp.",
                job_id,
                YTDLP_STALL_SECONDS,
            )
            _signal_process_group(process, force=True)
            return

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
            start_new_session=True,
            env=_yt_dlp_environment(),
        )
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _signal_process_group(process)
                return
            current_job["process"] = process
            if current_job["cancel_requested"]:
                _signal_process_group(process)

        threading.Thread(target=stop_stalled_download, daemon=True).start()

        for line in process.stdout or []:
            last_output_at[0] = time.monotonic()
            output_tail.append(line.strip())
            if len(output_tail) > 40:
                del output_tail[0]
            if "Requested format is not available" in line:
                compatible_format_missing = True
            if _is_rate_limit_line(line):
                rate_limit_hits += 1
            with JOBS_LOCK:
                current_job = JOBS.get(job_id)
                if not current_job:
                    _signal_process_group(process)
                    break
                if current_job["cancel_requested"]:
                    _signal_process_group(process)
                    break
                # YouTube throttling during extraction means retrying will
                # just spin for minutes. Stop immediately; during an active
                # media transfer, allow one retry before giving up.
                if rate_limit_hits and (rate_limit_hits >= 2 or not current_job.get("progress")):
                    rate_limited = True
                    LOGGER.warning(
                        "Download job %s was rate-limited by YouTube; stopping yt-dlp instead of retrying.",
                        job_id,
                    )
                    _signal_process_group(process)
                    break
                if "[Merger]" in line or ("[ExtractAudio]" in line and "Not converting audio" not in line):
                    current_job["status"] = "converting"
                    current_job["stage"] = "processing"
                    current_job["updated_at"] = time.time()
                match = PROGRESS_PATTERN.search(line)
                if match:
                    current_job["status"] = "downloading"
                    current_job["progress"] = min(99, max(0, float(match.group(1))))
                    current_job["stage"] = "downloading"
                    current_job["updated_at"] = time.time()
                    if not first_progress_logged[0]:
                        first_progress_logged[0] = True
                        LOGGER.info(
                            "Download job %s reached media data after %.1fs",
                            job_id,
                            time.monotonic() - started_at,
                        )
                elif not current_job.get("progress"):
                    current_job["stage"] = "resolving"
                speed_match = SPEED_PATTERN.search(line)
                eta_match = ETA_PATTERN.search(line)
                if speed_match:
                    current_job["speed"] = speed_match.group(1)
                if eta_match:
                    current_job["eta"] = eta_match.group(1)

        return_code = process.wait()
        if rate_limited:
            raise DownloadFailure(RATE_LIMIT_MESSAGE)
        if stalled:
            raise DownloadFailure(
                f"The Pi downloader produced no output for {YTDLP_STALL_SECONDS} seconds, so it was stopped. "
                "YouTube may be slow to respond or the Pi may be solving its JavaScript challenge too slowly. "
                "Try again, and raise PUFFIN_YTDLP_STALL_SECONDS in the Pi service environment if this video legitimately needs longer."
            )
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            current_job["process"] = None
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["stage"] = "cancelled"
                current_job["worker_active"] = False
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return
            # The media transfer is done; everything from here on (subtitle
            # pass, container checks, audio conversion) is post-processing.
            current_job["stage"] = "processing"
            current_job["updated_at"] = time.time()

        download_error = None
        if return_code != 0:
            if compatible_format_missing:
                raise DownloadFailure("YouTube did not provide a downloadable video and audio format for this item.")
            download_error = _yt_dlp_failure_message(output_tail, return_code)
            if job["kind"] == "audio":
                raise DownloadFailure(download_error)

        subtitle_file = None
        subtitle_language = None
        if job["kind"] == "video":
            _download_subtitles(job, work_dir)
            subtitle_files = [
                path for path in work_dir.iterdir()
                if path.is_file() and path.suffix.lower() == ".vtt" and path.stat().st_size <= 5 * 1024 * 1024
            ]
            subtitle_file = _choose_subtitle_file(subtitle_files, job.get("preferred_subtitle_language", "en"))
            subtitle_language = _subtitle_language_from_path(subtitle_file) if subtitle_file else None
            if subtitle_file:
                LOGGER.info(
                    "Video download job %s found subtitle languages %s; selected %s",
                    job_id,
                    ", ".join(sorted({_subtitle_language_from_path(path) for path in subtitle_files})),
                    subtitle_language,
                )
            else:
                LOGGER.info("Video download job %s found no downloadable WebVTT subtitles", job_id)
        output_files = [
            path for path in work_dir.iterdir()
            if path.is_file() and path.suffix.lower() != ".vtt"
            and not path.name.endswith((".part", ".ytdl", ".json", ".jpg", ".webp"))
        ]
        if not output_files:
            raise DownloadFailure(download_error or "yt-dlp finished but did not create a media file. Check the Pi service logs for details.")

        if job["kind"] == "audio":
            output_file = max(output_files, key=lambda path: path.stat().st_mtime)
            output_file = _ensure_supported_audio(output_file, job.get("supported_audio_formats") or [], job)
        else:
            video_files = sorted(
                output_files,
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            )
            output_file = next((path for path in video_files if _has_audio_and_video_streams(path)), None)
            if output_file:
                output_file = _make_compatible_mp4(output_file, current_job or job)
            else:
                video_only = next((
                    path for path in video_files
                    if any(stream.get("codec_type") == "video" for stream in _media_streams(path))
                ), None)
                audio_only = next((
                    path for path in video_files
                    if path != video_only and any(stream.get("codec_type") == "audio" for stream in _media_streams(path))
                ), None)
                if not video_only or not audio_only:
                    found = ", ".join(path.name for path in video_files) or "no media files"
                    detail = f" yt-dlp reported: {download_error}" if download_error else ""
                    raise DownloadFailure(f"Could not find both downloaded tracks to combine ({found}).{detail}")
                output_file = _make_compatible_mp4(video_only, current_job or job, audio_only)
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["stage"] = "cancelled"
                current_job["worker_active"] = False
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return
        output_size = output_file.stat().st_size
        if output_size > MAX_DOWNLOAD_BYTES:
            raise DownloadFailure("The download exceeded the configured file size limit.")

        actual_video_height = None
        if job["kind"] == "video":
            streams = _media_streams(output_file)
            video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
            requested_video_height = job.get("video_height", 720)
            actual_video_height = _verify_video_resolution(
                video_stream.get("height") if video_stream else None,
                requested_video_height,
            )
            LOGGER.info(
                "Video download job %s resolved to %sp (requested maximum %sp, %s bytes)",
                job_id,
                actual_video_height,
                requested_video_height,
                output_size,
            )

        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["stage"] = "cancelled"
                current_job["worker_active"] = False
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return
            current_job.update({
                "status": "ready",
                "stage": "completed",
                "worker_active": False,
                "progress": 100,
                "filename": _safe_filename(output_file),
                "file_path": str(output_file),
                "size": output_size,
                "mime_type": AUDIO_MIME_TYPES.get(output_file.suffix.lower().lstrip(".")) if job["kind"] == "audio" else (mimetypes.guess_type(output_file.name)[0] or "application/octet-stream"),
                "actual_video_height": actual_video_height,
                "subtitle_path": str(subtitle_file) if subtitle_file else None,
                "subtitle_size": subtitle_file.stat().st_size if subtitle_file else 0,
                "subtitle_language": subtitle_language,
                "ready_at": time.time(),
                "updated_at": time.time(),
            })
        LOGGER.info("Download job %s is ready (%s bytes)", job_id, output_size)
    except FileNotFoundError as error:
        if process and process.poll() is None:
            _terminate_process_group(process)
        missing = Path(error.filename).name if error.filename else "a required file"
        message = f"The Pi could not run {missing}. Check the service PATH and installed tools, then retry."
        _fail_job(job_id, message)
        LOGGER.warning("Download job %s failed (%s): %s", job_id, type(error).__name__, message)
    except Exception as error:
        if process and process.poll() is None:
            _terminate_process_group(process)
        message = str(error) if isinstance(error, DownloadFailure) else "The download failed unexpectedly. Check the Pi service logs for details."
        message = _safe_diagnostic(message)
        _fail_job(job_id, message)
        LOGGER.warning("Download job %s failed (%s): %s", job_id, type(error).__name__, message)


def _fail_job(job_id: str, message: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["process"] = None
        job["worker_active"] = False
        job["status"] = "failed"
        job["stage"] = "failed"
        job["error"] = message
        job["updated_at"] = time.time()
        _remove_work_directory(job)


def _cleanup_expired_jobs() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with JOBS_LOCK:
            expired = [
                job_id for job_id, job in JOBS.items()
                if job["status"] in {"ready", "failed", "cancelled"}
                and not job["transfers"]
                and now - (job.get("ready_at") or job["updated_at"]) > JOB_RETENTION_SECONDS
            ]
            for job_id in expired:
                _remove_work_directory(JOBS.pop(job_id))


class PuffinHandler(BaseHTTPRequestHandler):
    server_version = "PuffinDownloader/1.0"

    def log_message(self, format_string: str, *args) -> None:
        # Avoid logging full request paths, which may contain private video URLs.
        LOGGER.info("%s %s", self.command, self.path.split("?", 1)[0])

    def _origin(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin is None:
            return None
        return origin.rstrip("/")

    def _origin_allowed(self) -> bool:
        origin = self._origin()
        return origin is None or origin in ALLOWED_ORIGINS

    def _cors_headers(self) -> None:
        origin = self._origin()
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, X-Download-Name")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self, status: int = 204) -> None:
        self.send_response(status)
        self._cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _reject_origin(self) -> bool:
        if self._origin_allowed():
            return False
        self._json(403, {"error": "This Puffin website origin is not allowed by the Pi service."})
        return True

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if length <= 0 or length > 16_384:
            raise ValueError("Request body must be between 1 byte and 16 KB.")
        try:
            value = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as error:
            raise ValueError("Request body must be valid JSON.") from error
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object.")
        return value

    def do_OPTIONS(self) -> None:
        if self._reject_origin():
            return
        self.send_response(204)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:
        if self._reject_origin():
            return
        parsed_path = urlsplit(self.path)
        path_parts = [unquote(part) for part in parsed_path.path.strip("/").split("/")]

        if path_parts == ["api", "health"]:
            runtimes = [
                {"name": name, "path": str(binary)} for name, binary in _find_js_runtimes()
            ]
            self._json(200, {
                "ok": True,
                "service": "puffin-downloader",
                "video_quality_options": list(VIDEO_QUALITY_OPTIONS),
                "js_runtimes": runtimes,
            })
            return

        if path_parts == ["api", "search"]:
            query = parse_qs(parsed_path.query).get("q", [""])[0].strip()
            if not query or len(query) > 200:
                self._json(400, {"error": "Enter a YouTube search between 1 and 200 characters."})
                return
            try:
                videos = _search_youtube(query)
            except subprocess.TimeoutExpired:
                self._json(504, {"error": "YouTube search timed out. Try again in a moment."})
                return
            except subprocess.CalledProcessError as error:
                detail = (error.stderr or "").lower() if isinstance(error.stderr, str) else ""
                if _is_rate_limit_line(detail):
                    self._json(429, {"error": "YouTube rate-limited the Pi. Wait a few minutes before searching again."})
                else:
                    self._json(502, {"error": "YouTube search failed. Check the Pi connection and try again."})
                return
            except Exception as error:
                LOGGER.warning("YouTube search failed: %s", type(error).__name__)
                self._json(502, {"error": "YouTube search failed. Check the Pi connection and try again."})
                return
            self._json(200, {"videos": videos})
            return

        if len(path_parts) == 3 and path_parts[:2] == ["api", "downloads"]:
            with JOBS_LOCK:
                job = JOBS.get(path_parts[2])
                response = _public_job(job) if job else None
            if response is None:
                self._json(404, {"error": "Download job not found or expired."})
            else:
                self._json(200, response)
            return

        if len(path_parts) == 4 and path_parts[:2] == ["api", "downloads"] and path_parts[3] == "file":
            self._send_job_file(path_parts[2])
            return

        if len(path_parts) == 4 and path_parts[:2] == ["api", "downloads"] and path_parts[3] == "subtitles":
            self._send_job_subtitles(path_parts[2])
            return

        self._json(404, {"error": "Endpoint not found."})

    def _send_job_file(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job or job["status"] != "ready":
                self._json(409, {"error": "The download is not ready."})
                return
            file_path = Path(job["file_path"])
            filename = job["filename"]
            mime_type = job["mime_type"]
            size = job["size"]
            job["transfers"] += 1

        try:
            media_file = file_path.open("rb")
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
            self.send_header("X-Download-Name", quote(filename, safe=""))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            with media_file:
                while True:
                    chunk = media_file.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except FileNotFoundError:
            self._json(410, {"error": "The temporary download file has expired."})
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.info("File transfer for job %s was interrupted; keeping the temporary file for retry.", job_id)
        finally:
            with JOBS_LOCK:
                current_job = JOBS.get(job_id)
                if current_job:
                    current_job["transfers"] = max(0, current_job["transfers"] - 1)

    def _send_job_subtitles(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job or job["status"] != "ready":
                self._json(409, {"error": "The download is not ready."})
                return
            subtitle_path = job.get("subtitle_path")
            if not subtitle_path:
                self._json(404, {"error": "No downloadable subtitles were available for this video."})
                return
            subtitle_file = Path(subtitle_path)
            size = subtitle_file.stat().st_size if subtitle_file.exists() else 0
            job["transfers"] += 1

        try:
            with subtitle_file.open("rb") as subtitle_stream:
                self.send_response(200)
                self._cors_headers()
                self.send_header("Content-Type", "text/vtt; charset=utf-8")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                while True:
                    chunk = subtitle_stream.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except FileNotFoundError:
            self._json(410, {"error": "The temporary subtitle file has expired."})
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.info("Subtitle transfer for job %s was interrupted; keeping the temporary file for retry.", job_id)
        finally:
            with JOBS_LOCK:
                current_job = JOBS.get(job_id)
                if current_job:
                    current_job["transfers"] = max(0, current_job["transfers"] - 1)

    def do_POST(self) -> None:
        if self._reject_origin():
            return
        path_parts = [unquote(part) for part in urlsplit(self.path).path.strip("/").split("/")]

        if path_parts == ["api", "downloads"]:
            self._create_download()
            return

        if len(path_parts) == 4 and path_parts[:2] == ["api", "downloads"] and path_parts[3] == "complete":
            self._complete_download(path_parts[2])
            return

        self._json(404, {"error": "Endpoint not found."})

    def _create_download(self) -> None:
        try:
            request = self._read_json()
        except ValueError as error:
            self._json(400, {"error": str(error)})
            return

        url = request.get("url")
        kind = request.get("kind")
        if not _is_allowed_media_url(url):
            self._json(400, {"error": "Enter an HTTPS YouTube video URL or a valid YouTube search query."})
            return
        if not isinstance(kind, str) or kind not in {"audio", "video"}:
            self._json(400, {"error": "Choose audio (M4A) or video (MP4)."})
            return
        requested_audio_formats = request.get("supported_audio_formats", [])
        preferred_subtitle_language = _normalize_subtitle_language(request.get("preferred_subtitle_language", "en"))
        video_height = request.get("video_height", 720)
        if type(video_height) is not int or video_height not in VIDEO_QUALITY_OPTIONS:
            self._json(400, {"error": "Choose a valid video quality."})
            return
        if not isinstance(requested_audio_formats, list):
            requested_audio_formats = []
        supported_audio_formats = [
            extension.lower()
            for extension in requested_audio_formats
            if isinstance(extension, str) and extension.lower() in SUPPORTED_AUDIO_EXTENSIONS
        ]

        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with JOBS_LOCK:
            existing_job = next((
                job for job in JOBS.values()
                if job["status"] in {"queued", "downloading", "converting"}
                or (job["status"] == "ready" and job["transfers"])
            ), None)
            if existing_job:
                self._json(409, {"error": "Finish or cancel the current Pi download before starting another."})
                return

            # A completed but unconfirmed file is replaceable when another
            # download is requested; the original client's local save failed
            # or it never returned to confirm receipt.
            for old_job_id, old_job in list(JOBS.items()):
                if old_job["status"] == "ready" and not old_job["transfers"]:
                    _remove_work_directory(old_job)
                    del JOBS[old_job_id]

            free_bytes = shutil.disk_usage(DOWNLOAD_DIR).free
            if free_bytes < MIN_FREE_BYTES:
                self._json(507, {"error": "The Pi is low on free storage. Clear space before downloading."})
                return

            job_id = uuid.uuid4().hex
            work_dir = DOWNLOAD_DIR / job_id
            work_dir.mkdir(mode=0o700)
            job = {
                "id": job_id,
                "url": url,
                "kind": kind,
                "supported_audio_formats": supported_audio_formats,
                "video_height": video_height,
                "preferred_subtitle_language": preferred_subtitle_language,
                "status": "queued",
                "stage": "preparing",
                "progress": 0,
                "speed": None,
                "eta": None,
                "error": None,
                "filename": None,
                "file_path": None,
                "size": None,
                "mime_type": None,
                "work_dir": str(work_dir),
                "created_at": time.time(),
                "updated_at": time.time(),
                "ready_at": None,
                "process": None,
                "cancel_requested": False,
                "worker_active": True,
                "transfers": 0,
            }
            JOBS[job_id] = job

        try:
            threading.Thread(target=_run_download_worker, args=(job_id,), daemon=True).start()
        except RuntimeError as error:
            _fail_job(job_id, "The Pi could not start a download worker. Restart the downloader service and try again.")
            LOGGER.error("Could not start download job %s worker: %s", job_id, type(error).__name__)
            self._json(503, {"error": "The Pi is busy and could not start a download. Try again shortly."})
            return
        self._json(202, _public_job(job))

    def _complete_download(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                self._json(404, {"error": "Download job not found or expired."})
                return
            if job["status"] != "ready":
                self._json(409, {"error": "Only a ready download can be confirmed."})
                return
            if job["transfers"]:
                self._json(409, {"error": "Wait for the file transfer to finish before confirming it."})
                return
            _remove_work_directory(job)
            del JOBS[job_id]

        LOGGER.info("Puffin confirmed and removed download job %s", job_id)
        self._no_content()

    def do_DELETE(self) -> None:
        if self._reject_origin():
            return
        path_parts = [unquote(part) for part in urlsplit(self.path).path.strip("/").split("/")]
        if len(path_parts) != 3 or path_parts[:2] != ["api", "downloads"]:
            self._json(404, {"error": "Endpoint not found."})
            return

        job_id = path_parts[2]
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                self._json(404, {"error": "Download job not found or expired."})
                return
            if job["transfers"]:
                self._json(409, {"error": "Wait for the current file transfer to finish before cancelling."})
                return
            job["cancel_requested"] = True
            process = job.get("process")
            if process and process.poll() is None:
                _signal_process_group(process)
            if job["status"] == "ready":
                _remove_work_directory(job)
                del JOBS[job_id]
            elif job.get("worker_active"):
                # Let the worker clean up its directory once it has stopped
                # using it; removing it here races with post-download checks.
                pass
            else:
                job["status"] = "cancelled"
                job["stage"] = "cancelled"
                job["updated_at"] = time.time()
                _remove_work_directory(job)

        self._no_content(202)


def _remove_stale_files() -> None:
    """Clear abandoned Puffin job folders without touching unrelated files."""
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for path in DOWNLOAD_DIR.iterdir():
        if path.is_dir() and re.fullmatch(r"[0-9a-f]{32}", path.name):
            shutil.rmtree(path, ignore_errors=True)


def _warm_yt_dlp_capabilities() -> None:
    """Run the slow yt-dlp capability probe before the first job needs it."""
    try:
        _yt_dlp_supports_js_runtimes()
    except Exception:
        LOGGER.exception("Could not probe yt-dlp capabilities")


def main() -> None:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    _remove_stale_files()
    threading.Thread(target=_cleanup_expired_jobs, daemon=True).start()
    threading.Thread(target=_warm_yt_dlp_capabilities, daemon=True).start()

    runtimes = _find_js_runtimes()
    LOGGER.info(
        "JavaScript runtimes for yt-dlp: %s",
        ", ".join(f"{name} ({binary})" for name, binary in runtimes) or "none found",
    )
    if runtimes and all(name == "quickjs" for name, _ in runtimes):
        LOGGER.warning(
            "Only QuickJS is available for YouTube's JavaScript challenge. QuickJS has no JIT and makes "
            "downloads start very slowly on a Pi; install Node.js 22 or newer and restart the service."
        )

    server = ThreadingHTTPServer((HOST, PORT), PuffinHandler)
    LOGGER.info("Puffin downloader listening on %s:%s", HOST, PORT)
    LOGGER.info("Allowing browser origins: %s", ", ".join(sorted(ALLOWED_ORIGINS)) or "none")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Stopping Puffin downloader")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
