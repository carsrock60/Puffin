# Raspberry Pi downloader setup

The Pi service runs `yt-dlp` as a private, job-based API. Puffin requests an audio or video download, polls for progress, receives the result, saves it in the device's IndexedDB library, and then confirms the save so the Pi can delete its temporary file.

The service accepts HTTPS YouTube URLs and supports audio (M4A) or video (MP4). It permits one active download or file transfer at a time. A new request replaces an older completed file that Puffin did not confirm. The default temporary file limit is 2 GiB, and the default free-space reserve is 1 GiB. An unconfirmed file is removed after one hour. Job state is held in memory, so a Pi restart cancels active jobs and clears abandoned Puffin job folders.

## Install on Raspberry Pi OS

Clone the repository onto the Pi, then install the system dependencies and Python environment. These commands assume Raspberry Pi OS and that you will clone the repo into `~/Puffin`:

```sh
git clone https://github.com/carsrock60/Puffin.git ~/Puffin
sudo apt update
sudo apt install -y python3-venv ffmpeg
cd ~/Puffin/pi-service
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

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

Replace the placeholder values, then enable the service:

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
