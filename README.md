# Puffin

Puffin is a music and video app for macOS and Windows, with a companion website that runs as a Progressive Web App (PWA). The interface adapts to desktop and mobile screens. Its main features are downloading, editing, playing, and tracking music and video.

## Discover

Discover is the first page users see. It builds a small listening profile from the local library and listening history, then asks Puffin's discovery service for personalized artists and albums. Recommendations combine Last.fm artist and track similarity, favor artists supported by more than one seed, limit how often one seed can repeat, and space out artists with overlapping tags. Artists already in the library are excluded, and artists recently recommended are de-prioritized. The page shows rich artist cards with the reason each artist was picked, a horizontal Explore artists row, and album artwork from MusicBrainz, Cover Art Archive, and iTunes. Selecting an artist opens a native dialog with a photo, bio, tags, albums, and popular tracks, with working actions to find music, open the library, or search Puffin.

Artwork is matched conservatively. Fanart.tv is used for artist photography when configured; Last.fm images are a fallback; otherwise Puffin shows a designed monogram rather than a fake photo. Album covers come from a matching MusicBrainz release group and Cover Art Archive image; when that image is missing, Puffin tries an exact artist/album iTunes match and otherwise uses a designed placeholder.

### Discover configuration

The discovery service lives in `discover-service/` and reads credentials only from server-side environment variables. Do not put these values in the frontend, a checked-in file, or browser storage.

- `LASTFM_API_KEY` (required): Last.fm API key used for similar artists and tracks.
- `FANART_API_KEY` (optional, recommended): Fanart.tv personal API key for artist photos. Without it, Puffin falls back to Last.fm images and then monograms.
- `MUSICBRAINZ_USER_AGENT` (strongly recommended): A descriptive User-Agent with contact information, for example `Puffin/1.0 (https://github.com/carsrock60/Puffin)`. MusicBrainz requires an identifying User-Agent and limits clients to roughly one request per second.

For Vercel, add these to the project's Environment Variables and redeploy. The API returns HTTP 200 with `status: "unconfigured"` when `LASTFM_API_KEY` is missing, so the app shows a calm setup state instead of fake recommendations. If Last.fm rejects the key, the app explains that the host needs to reconnect its music catalog; if Last.fm rate-limits requests, it reports a retryable error. Either way, a saved mix stays visible when one exists.

To run the service locally:

```sh
cd discover-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
```

Then run `npm run dev` in `web/`. Vite proxies `/api/discover` to `http://127.0.0.1:8001`. Run the service tests with `python3 -m unittest discover -s discover-service -p 'test_*.py'`.

Similarities are cached for 24 hours, artist metadata for 7 days, Fanart and release-group lookups for 7 days, artwork for 7 days, and final recommendation sets for about 45 minutes. Empty results use shorter negative caches. Repeated requests for the same key share one in-flight request, and the service applies provider-specific concurrency limits and timeouts.

### Discover privacy

Puffin never uploads the full library or raw listening history. A recommendation request contains at most 8 seed artists, up to 2 track titles per seed, coarse play and library counts, up to 40 artist names already in the library to exclude, and recent recommendation names to avoid repeating. Last.fm receives only the seed artist or track needed for a similarity lookup. Fanart.tv receives a MusicBrainz artist ID. MusicBrainz and Cover Art Archive receive artist IDs and release-group IDs. iTunes receives artist and album names for artwork fallback. All project keys stay on the server.

## Desktop app

Puffin is available as a standalone desktop app for macOS (Apple silicon and Intel) and Windows (x64). The website remains available at [puffin-iota.vercel.app](https://puffin-iota.vercel.app), but downloads run only in the desktop app, on the computer itself.

- **Nothing else is required.** The app bundles its FFmpeg engine and installs its own `yt-dlp` engine on first use. There is no downloader server, private network, extra hardware, or account to configure.
- **A separate local library.** The desktop app stores media in its own application storage. A browser library is not imported automatically, so you can keep using the website without mixing the two libraries.
- **Built-in updates.** Puffin checks GitHub Releases quietly after launch and every six hours. A small dot on the Settings icon signals an update without covering the main screen. The update panel can check, download an installer in-app on Windows, or open the release page on macOS.
- **Laptop-only website button.** On laptop and desktop browsers, a download button sits to the left of the connectivity icon and picks the correct macOS or Windows installer. Phones and tablets do not see it, and the app hides it once it is already running.

Download the latest installer from [GitHub Releases](https://github.com/carsrock60/Puffin/releases/latest). macOS builds are arm64 for Apple silicon and x64 for Intel Macs, as a DMG with a ZIP fallback; Windows builds are x64 NSIS installers.

## Download

In the desktop app, users can paste a YouTube link or search YouTube without leaving Puffin. Search results show video thumbnails, titles, channels, and durations; selecting a result starts a download with a local progress display that can be cancelled at any time. Audio downloads preserve the source audio format when it is playable, with AAC in M4A as a compatibility fallback. Video downloads prefer H.264 video and AAC audio in MP4, and fall back to WebM when that is the only playable option. Available manual, automatic, and translated subtitles are saved with downloaded videos in the computer's preferred language when available, and can be toggled during playback.

Downloads are intended for public-domain videos or users' own videos. Users are trusted to download only content they are authorized to download.

### Download workflow

1. The desktop app resolves the link or search with its bundled `yt-dlp` engine, downloading the engine on first use if it is not already present.
2. `yt-dlp` downloads video, audio, and WebVTT subtitles into a private temporary folder. FFmpeg merges the selected streams into a playable container.
3. The app verifies the video's actual height against the selected maximum, then streams the finished file over a private in-app protocol into Puffin's library.
4. The temporary folder is removed after the library save succeeds. Interrupted downloads are cleaned up on the next launch.

The download engine runs entirely on the computer. Nothing is uploaded to Puffin, and no other device is contacted.

### Build and release

```sh
cd web && npm install && npm run build
cd ../desktop && npm install
npm start             # build the web app and launch the desktop shell
npm run dist:mac      # Apple silicon ZIP and DMG
npm run dist:mac:intel # Intel ZIP and DMG
npm run dist:win      # Windows x64 NSIS installer
```

Installers are written to `desktop/release/` with names the website installer picker understands: `Puffin-<version>-arm64.dmg` (or `.zip` fallback), `Puffin-<version>-x64.dmg` (or `.zip`), and `Puffin-Setup-<version>-x64.exe`. Build each installer on matching hardware: `ffmpeg-static` installs a native binary for the host. The release workflow in `.github/workflows/desktop-release.yml` runs tests and builds on matching Apple silicon, Intel Mac, and Windows runners whenever a `v*` tag is pushed. macOS builds check GitHub Releases and open the download page, because unsigned apps cannot install updates themselves; Windows installs can download and run the new NSIS installer in-app. Code-signing both platforms later removes the Gatekeeper and SmartScreen warnings.

The desktop shell serves the built website over a privileged `puffin://` protocol, proxies Discover and Smart Fill requests to the hosted Puffin service, and uses `puffin-media://` only for the short handoff from the temporary download to the local library.

## Edit

The Edit tab is a music tag editor with the following features:

- **Batch editing:** Modify multiple files at once to standardize capitalization, genres, album titles, and other tags.
- **Filename and tag conversion:** Convert between filenames and tags using custom naming masks.
- **Metadata lookup:** Look up metadata from online sources such as MusicBrainz.

Smart Fill fingerprints audio in the browser when an AcoustID application key is configured in **Settings → Home**. Without that optional key it uses an exact title and artist search instead. Groq's `openai/gpt-oss-20b` ranks MusicBrainz candidates and can leave them unselected when it cannot confirm a good match. For the deployed app, add `GROQ_API_KEY` to the Vercel project's Environment Variables and redeploy; the key is only read by the Python service and is never sent to browsers. The Python service validates model output with Pydantic before returning candidates. Run the Vercel Services project with `vercel dev` when testing the Groq ranking endpoint locally.

## Watch

The Watch page gathers videos saved in the device's Puffin library. It features a featured video, Continue Watching, Recently Watched, and a searchable video library. Video playlists created in Play can filter the Watch library. Puffin saves watch progress on the device so playback can resume later. The expanded player includes seeking, volume, playback speed, and fullscreen controls; closing it returns playback to the mini-player.

## Play

The Play tab provides the local library and playlists, with the compact player focused on music. Desktop downloads preserve a playable source audio format where possible, with AAC in M4A as a compatibility fallback. Files imported from the device are kept in their original format; playback depends on the codecs the computer supports. Users can create, rename, and delete playlists, add or remove local media, and pin playlists to the top. Playlist data and media files are stored on the device. It includes a 10-band equalizer with:

- **Multiple bands:** Support five to ten or more bands, covering core hearing ranges from sub-bass (20–60 Hz) to treble and air (8–16+ kHz). A 10-band graphic equalizer offers a balance between control and simplicity.
- **Preset profiles:** Quick-start modes such as Hip Hop, Rock, Pop, Classical, Vocal Boost, and Flat.
- **Preamp / gain control:** Lower overall volume when boosting frequencies to help prevent digital clipping and distortion.
- **Custom presets:** Save, name, and recall frequency curves for different headphones or speakers.

The player also includes play and pause, playback speed, and a smooth scrub bar.

## Stats

The Stats tab displays separate tables ranking the most frequently played artists, albums, and songs. It also shows total listening time and the storage space used by media files. Users can reset their statistics.

## Interface

The app has an expandable desktop sidebar and a touch-friendly mobile navigation drawer, grouped into Browse, Your Library, and Tools. Discover is the default page and learns from the local library and listening history. Listen filters the local library to audio; Library shows all media; Playlists opens the existing playlist browser. Home shows recently played music and quick playlist access.

The video theater overlays its title and playback controls over the full video area. Pointer, touch, or keyboard activity reveals the controls; they fade after three seconds without activity.
