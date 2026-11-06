# Puffin

Puffin is a music and video app for macOS and iOS. It is designed as a static Progressive Web App (PWA), hosted on Vercel, with an interface that adapts to desktop and mobile screens. Its main features are downloading, editing, playing, and tracking music and video.

## Download

Users can paste a YouTube link or search YouTube within Puffin. Search results show video thumbnails, titles, channels, and durations; users can preview a result in YouTube or select it for download. Audio downloads preserve the source audio format when the browser supports it, with AAC in M4A as a compatibility fallback. Video downloads use H.264 video and AAC audio in MP4 for browser compatibility.

Downloads are intended for public-domain videos or users' own videos. Users are trusted to download only content they are authorized to download.

### Download workflow

The PWA sends a download request to a private service running on a Raspberry Pi. The Pi runs `yt-dlp`, temporarily stores the downloaded file, and streams it to the device that requested it. Puffin saves the file in that device's browser storage for offline playback. After Puffin confirms that the local save succeeded, the Pi deletes its temporary copy. The Pi has approximately 18 GB of available storage for temporary files.

The Raspberry Pi service is intended to be reachable only over a private network. Tailscale must be installed and connected on the Pi and on each Mac or iPhone that will request downloads. If the Pi or private connection is unavailable, new downloads cannot be requested; files already saved on a device remain available offline.

The Pi service setup, including Raspberry Pi OS commands, Tailscale Serve, and an optional systemd service for automatic startup, is documented in [pi-service/README.md](pi-service/README.md). Set `PUFFIN_ALLOWED_ORIGINS` there to the exact Vercel deployment origin and any local development origin you use. The Pi stores downloads only temporarily; Puffin stores each completed file in the requesting device's browser storage.

## Edit

The Edit tab is a music tag editor with the following features:

- **Batch editing:** Modify multiple files at once to standardize capitalization, genres, album titles, and other tags.
- **Filename and tag conversion:** Convert between filenames and tags using custom naming masks.
- **Metadata lookup:** Look up metadata from online sources such as MusicBrainz.

Smart Fill fingerprints audio in the browser when an AcoustID application key is configured in **Settings → Home**. Without that optional key it uses an exact title and artist search instead. Groq's `openai/gpt-oss-20b` ranks MusicBrainz candidates and can leave them unselected when it cannot confirm a good match. For the deployed app, add `GROQ_API_KEY` to the Vercel project's Environment Variables and redeploy; the key is only read by the Python service and is never sent to browsers. The Python service validates model output with Pydantic before returning candidates. Run the Vercel Services project with `vercel dev` when testing the Groq ranking endpoint locally.

## Watch

The Watch page gathers videos saved in the device's Puffin library. It features a featured video, Continue Watching, Recently Watched, and a searchable video library. Video playlists created in Play can filter the Watch library. Puffin saves watch progress on the device so playback can resume later. The expanded player includes seeking, volume, playback speed, and fullscreen controls; closing it returns playback to the mini-player.

## Play

The Play tab provides the local library and playlists, with the compact player focused on music. Pi downloads preserve a browser-supported source audio format where possible, with AAC in M4A as a compatibility fallback. Files imported from the device are kept in their original format; browser playback depends on the codecs the browser supports. Users can create, rename, and delete playlists, add or remove local media, and pin playlists to the top. Playlist data and media files are stored on the device. It includes a 10-band equalizer with:

- **Multiple bands:** Support five to ten or more bands, covering core hearing ranges from sub-bass (20–60 Hz) to treble and air (8–16+ kHz). A 10-band graphic equalizer offers a balance between control and simplicity.
- **Preset profiles:** Quick-start modes such as Hip Hop, Rock, Pop, Classical, Vocal Boost, and Flat.
- **Preamp / gain control:** Lower overall volume when boosting frequencies to help prevent digital clipping and distortion.
- **Custom presets:** Save, name, and recall frequency curves for different headphones or speakers.

The player also includes play and pause, playback speed, and a smooth scrub bar.

## Stats

The Stats tab displays separate tables ranking the most frequently played artists, albums, and songs. It also shows total listening time and the storage space used by media files. Users can reset their statistics.

## Interface

The app has an expandable desktop sidebar and a touch-friendly mobile navigation drawer, grouped into Discover, Your Library, and Tools. Listen filters the local library to audio; Library shows all media; Playlists opens the existing playlist browser. Home shows recently played music and optional music picks.

The video theater overlays its title and playback controls over the full video area. Pointer, touch, or keyboard activity reveals the controls; they fade after three seconds without activity.
