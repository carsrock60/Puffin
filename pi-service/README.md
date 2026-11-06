# Raspberry Pi downloader setup

The Pi service runs `yt-dlp` as a private, job-based API. Puffin requests an audio or video download, polls for progress, receives the result, saves it in the device's IndexedDB library, and then confirms the save so the Pi can delete its temporary file.

The service accepts HTTPS YouTube URLs and `ytsearch:` search queries. Audio downloads preserve yt-dlp's audio-only source format when the requesting browser supports it; Puffin sends its supported audio formats with the request. If necessary, the Pi remuxes AAC into M4A without re-encoding, or converts incompatible audio to AAC/M4A at 192 kb/s. Puffin can search YouTube through the Pi's `GET /api/search?q=...` endpoint; this uses yt-dlp's flat search to return up to 10 video titles, channels, durations, URLs, and thumbnails without downloading media. CSV batches can submit a `ytsearch:` query for each `Track Name`, `Artist Name`, and `Album` row. Video downloads require the source to offer H.264 and AAC streams; the service reports an error when those formats are unavailable rather than returning a less-compatible codec. It permits one active download or file transfer at a time. A new request replaces an older completed file that Puffin did not confirm. The default temporary file limit is 2 GiB, and the default free-space reserve is 1 GiB. An unconfirmed file is removed after one hour. Job state is held in memory, so a Pi restart cancels active jobs and clears abandoned Puffin job folders.

YouTube now requires yt-dlp's JavaScript challenge solver and an external JavaScript runtime for full extraction support. The setup below installs the matching `yt-dlp-ejs` dependency and Deno. Puffin invokes yt-dlp through the service's own virtual-environment Python interpreter, so it does not depend on shell activation or systemd finding yt-dlp through `PATH`. [yt-dlp EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

## Install on Raspberry Pi OS

Clone the repository onto the Pi, then install the system dependencies and Python environment. These commands assume Raspberry Pi OS and that you will clone the repo into `~/Puffin`:

```sh
git clone https://github.com/carsrock60/Puffin.git ~/Puffin
sudo apt update
sudo apt install -y python3-venv ffmpeg curl
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"
cd ~/Puffin/pi-service
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install --upgrade -r requirements.txt
deno --version
.venv/bin/python -m yt_dlp --version
```

### Update an existing Pi installation

Pull the service changes and update the virtual-environment packages. If Deno is not installed for the Pi service user, install it. For a systemd installation, also add the `Environment=PATH=...` line shown below to `/etc/systemd/system/puffin-downloader.service` under `[Service]`, replacing `YOUR_PI_USER` with the Pi account name:

```sh
cd ~/Puffin
git pull --ff-only
cd pi-service
curl -fsSL https://deno.land/install.sh | sh
.venv/bin/python -m pip install --upgrade -r requirements.txt
.venv/bin/python -m yt_dlp --version
deno --version
sudo nano /etc/systemd/system/puffin-downloader.service
sudo systemctl daemon-reload
sudo systemctl restart puffin-downloader
sudo systemctl status puffin-downloader
```

The service unit needs this line, with the actual Pi username in place of `YOUR_PI_USER`:

```ini
Environment=PATH=/home/YOUR_PI_USER/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
```

If Deno is already installed, the install command can be skipped. The service must be restarted after updating so it uses the new code and dependencies.

Set the allowed browser origins. Include the Vercel site origin and the local Vite origin used during development. Origins have no trailing slash. For example, if your deployed app is `https://puffin.vercel.app`, include that exact origin:

```sh
export PUFFIN_ALLOWED_ORIGINS="https://your-puffin-site.vercel.app,http://localhost:5173"
export PUFFIN_DOWNLOAD_DIR="$HOME/puffin-downloads"
```

Start the service for an initial check:

```sh
.venv/bin/python app.py
```

It listens on `127.0.0.1:8765`, so it is not directly exposed to the local network. Leave this process running while testing. Stop it with Ctrl+C.

## Make the service privately reachable

Install and sign in to Tailscale on the Pi, Mac, and iPhone. With the Pi service running, publish it only inside your tailnet:

```sh
tailscale serve --bg 8765
```

Tailscale Serve will show an HTTPS URL such as `https://pi-name.example-tailnet.ts.net`. Enter that URL into Puffin's Pi address field. Keep Tailscale connected on devices that need to start downloads. Do not expose this service with port forwarding or Tailscale Funnel. [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve)

On each Mac or iPhone, install Tailscale and sign in to the same tailnet as the Pi. The device does not join your home Wi-Fi automatically; Tailscale creates the private connection over whatever internet connection the device is using. The Vercel-hosted Puffin page can then reach the Pi while Tailscale is connected.

## Keep it running after reboot

Copy `puffin-downloader.service.example` to `/etc/systemd/system/puffin-downloader.service`. Replace `/home/REPLACE_ME` in the unit with the Pi user's home directory, and replace `REPLACE_ME` with that user's account name. Create `/etc/puffin-downloader.env` with:

```ini
PUFFIN_ALLOWED_ORIGINS=https://your-puffin-site.vercel.app,http://localhost:5173
PUFFIN_DOWNLOAD_DIR=/home/REPLACE_ME/puffin-downloads
PUFFIN_MAX_DOWNLOAD_BYTES=2147483648
PUFFIN_MIN_FREE_BYTES=1073741824
```

Replace the placeholder values. The systemd example includes Deno's install directory in `PATH`; update that line if Deno is installed elsewhere. Then enable the service:

```sh
sudo chmod 600 /etc/puffin-downloader.env
sudo systemctl daemon-reload
sudo systemctl enable --now puffin-downloader
sudo systemctl status puffin-downloader
```

Run `tailscale serve --bg 8765` once for the Pi's Tailscale service. To inspect downloader logs later, use:

```sh
sudo journalctl -u puffin-downloader -f
```

The origin allowlist is a browser CORS rule, not authentication. Keep access private with Tailscale Serve and only add origins you control.
