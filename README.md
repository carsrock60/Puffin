# Puffin

Puffin is a music and video app for macOS and iOS. It is designed as a static Progressive Web App (PWA), hosted on Vercel, with an interface that adapts to desktop and mobile screens. Its main features are downloading, editing, playing, and tracking music and video.

## Download

Users can browse YouTube videos within Puffin and play previews to decide whether they want to download them. Users can choose audio or video and select M4A or MP4 format.

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

## Play

The Play tab plays downloaded audio and video. It includes an equalizer with:

- **Multiple bands:** Support five to ten or more bands, covering core hearing ranges from sub-bass (20–60 Hz) to treble and air (8–16+ kHz). A 10-band graphic equalizer offers a balance between control and simplicity.
- **Preset profiles:** Quick-start modes such as Rock, Pop, Classical, Vocal Boost, and Flat.
- **Preamp / gain control:** Lower overall volume when boosting frequencies to help prevent digital clipping and distortion.
- **Custom presets:** Save, name, and recall frequency curves for different headphones or speakers.

The player also includes an audio visualizer with dancing bars, play and pause, shuffle, repeat, queue controls (add to queue and edit queue), and a smooth scrub bar.

## Stats

The Stats tab displays separate tables ranking the most frequently played artists, albums, and songs. It also shows total listening time and the storage space used by media files. Users can reset their statistics.

## Interface

The home page should have a navigation menu for Download, Edit, Play, and Stats; a dark-mode button; and a settings gear icon. The main area should display:

> **Puffin: A Music Player**  
> Click an option to get started

The PWA should provide a more compact mobile layout while keeping all features available.
