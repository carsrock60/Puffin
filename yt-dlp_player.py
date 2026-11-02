import threading
import tkinter as tk
from tkinter import ttk, messagebox
import webbrowser
from io import BytesIO
import requests
from PIL import Image, ImageTk
import yt_dlp


class YouTubePlayerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("YouTube Player (yt-dlp Powered)")
        self.root.geometry("850x650")
        self.root.configure(bg="#121212")

        # Configure Tkinter dark theme styles
        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.style.configure("TFrame", background="#121212")
        self.style.configure("TLabel", background="#121212", foreground="#FFFFFF", font=("Helvetica", 10))
        self.style.configure("TButton", background="#1F1F1F", foreground="#FFFFFF", borderwidth=1)
        self.style.map("TButton", background=[("active", "#333333")])

        self.search_results = []
        self.thumbnail_cache = {}

        self._build_ui()

    def _build_ui(self):
        # Top Search Bar Section
        search_frame = ttk.Frame(self.root, padding=10)
        search_frame.pack(fill="x", side="top")

        ttk.Label(search_frame, text="Search YouTube:", font=("Helvetica", 11, "bold")).pack(
            side="left", padx=(0, 10)
        )

        self.search_entry = ttk.Entry(search_frame, font=("Helvetica", 11))
        self.search_entry.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.search_entry.bind("<Return>", lambda event: self.start_search())

        self.search_button = ttk.Button(search_frame, text="Search", command=self.start_search)
        self.search_button.pack(side="left")

        # Status Label
        self.status_label = ttk.Label(self.root, text="Type a search term and press Enter.", font=("Helvetica", 9, "italic"))
        self.status_label.pack(anchor="w", padx=15, pady=(0, 5))

        # Main Content Area (Scrollable Canvas for Video Cards)
        main_container = ttk.Frame(self.root)
        main_container.pack(fill="both", expand=True, padx=10, pady=5)

        self.canvas = tk.Canvas(main_container, bg="#181818", highlightthickness=0)
        self.scrollbar = ttk.Scrollbar(main_container, orient="vertical", command=self.canvas.yview)
        
        self.results_frame = ttk.Frame(self.canvas)
        self.results_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        )

        self.canvas.create_window((0, 0), window=self.results_frame, anchor="nw")
        self.canvas.configure(yscrollcommand=self.scrollbar.set)

        self.canvas.pack(side="left", fill="both", expand=True)
        self.scrollbar.pack(side="right", fill="y")

        # Bind mouse wheel scrolling
        self.canvas.bind_all("<MouseWheel>", lambda event: self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units"))

    def start_search(self):
        query = self.search_entry.get().strip()
        if not query:
            return

        self.status_label.config(text=f"Searching for '{query}'...")
        self.search_button.config(state="disabled")

        # Clear previous results
        for widget in self.results_frame.winfo_children():
            widget.destroy()

        # Execute yt-dlp search in a background thread to prevent GUI freezing
        threading.Thread(target=self._perform_yt_dlp_search, args=(query,), daemon=True).start()

    def _perform_yt_dlp_search(self, query):
        ydl_opts = {
            "extract_flat": True,      # Fast metadata lookup without fetching full formats
            "skip_download": True,     # Ensure NO video files are downloaded
            "quiet": True,
            "no_warnings": True,
        }

        search_target = f"ytsearch10:{query}"

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(search_target, download=False)
                entries = info.get("entries", [])
                
            self.root.after(0, self._display_results, entries)
        except Exception as e:
            self.root.after(0, self._handle_error, str(e))

    def _display_results(self, entries):
        self.search_button.config(state="normal")
        if not entries:
            self.status_label.config(text="No videos found.")
            return

        self.status_label.config(text=f"Found {len(entries)} videos.")

        for video in entries:
            video_url = video.get("url") or f"https://www.youtube.com/watch?v={video.get('id')}"
            title = video.get("title", "Untitled")
            uploader = video.get("uploader") or video.get("channel", "Unknown Channel")
            duration = video.get("duration")
            duration_str = self._format_duration(duration) if duration else "N/A"
            thumbnails = video.get("thumbnails", [])
            thumb_url = thumbnails[-1].get("url") if thumbnails else None

            # Video Card Container
            card = tk.Frame(self.results_frame, bg="#242424", bd=1, relief="solid")
            card.pack(fill="x", expand=True, padx=5, pady=5)

            # Thumbnail Label
            thumb_label = tk.Label(card, text="[Thumbnail]", bg="#333333", fg="#AAAAAA", width=16, height=5)
            thumb_label.pack(side="left", padx=10, pady=10)

            if thumb_url:
                threading.Thread(
                    target=self._load_thumbnail, args=(thumb_url, thumb_label), daemon=True
                ).start()

            # Video Metadata Frame
            meta_frame = tk.Frame(card, bg="#242424")
            meta_frame.pack(side="left", fill="both", expand=True, padx=10, pady=10)

            title_lbl = tk.Label(
                meta_frame, text=title, font=("Helvetica", 11, "bold"),
                bg="#242424", fg="#FFFFFF", anchor="w", justify="left", wraplength=450
            )
            title_lbl.pack(fill="x", anchor="w")

            sub_text = f"Channel: {uploader}  •  Duration: {duration_str}"
            sub_lbl = tk.Label(
                meta_frame, text=sub_text, font=("Helvetica", 9),
                bg="#242424", fg="#AAAAAA", anchor="w"
            )
            sub_lbl.pack(fill="x", anchor="w", pady=(5, 0))

            # Action Buttons
            btn_frame = tk.Frame(card, bg="#242424")
            btn_frame.pack(side="right", padx=10, pady=10)

            watch_btn = ttk.Button(
                btn_frame,
                text="▶ Stream in Browser",
                command=lambda url=video_url: self.open_in_browser(url)
            )
            watch_btn.pack(pady=2)

            get_stream_btn = ttk.Button(
                btn_frame,
                text="🔗 Fetch Direct Stream",
                command=lambda url=video_url: self.fetch_direct_stream_url(url)
            )
            get_stream_btn.pack(pady=2)

    def _load_thumbnail(self, url, label_widget):
        try:
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                img_data = resp.content
                img = Image.open(BytesIO(img_data))
                img.thumbnail((120, 90))
                photo = ImageTk.PhotoImage(img)

                # Update widget on main thread
                self.root.after(0, self._set_thumbnail, label_widget, photo)
        except Exception:
            pass

    def _set_thumbnail(self, label_widget, photo):
        label_widget.config(image=photo, width="", height="")
        label_widget.image = photo  # Keep reference to prevent garbage collection

    def open_in_browser(self, video_url):
        """Opens the video stream directly in the default web browser without downloading."""
        webbrowser.open(video_url)

    def fetch_direct_stream_url(self, video_url):
        """Extracts direct raw video/audio playback URLs via yt-dlp."""
        self.status_label.config(text="Extracting direct stream URL...")
        threading.Thread(target=self._get_direct_url_worker, args=(video_url,), daemon=True).start()

    def _get_direct_url_worker(self, video_url):
        ydl_opts = {
            # Select formats that have BOTH video and audio in a single stream
            "format": "b[acodec!=none][vcodec!=none] / best",
            "skip_download": True,
            "quiet": True,
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(video_url, download=False)
                
                # Check directly extracted URL or fallback to the requested format URL
                direct_url = info.get("url")
                if not direct_url and "requested_formats" in info:
                    direct_url = info["requested_formats"][0].get("url")

            if direct_url:
                self.root.after(0, self._show_direct_stream_dialog, direct_url)
            else:
                self.root.after(0, self._handle_error, "Could not resolve a direct stream URL.")
        except Exception as e:
            self.root.after(0, self._handle_error, str(e))

    def _show_direct_stream_dialog(self, direct_url):
        self.status_label.config(text="Direct stream extracted successfully.")
        
        # Open top-level popup to show extracted URL
        popup = tk.Toplevel(self.root)
        popup.title("Direct Stream URL")
        popup.geometry("600x200")
        popup.configure(bg="#1E1E1E")

        tk.Label(
            popup, text="Direct Stream Media Link (Use in VLC, MPV, or HTML5 Player):",
            bg="#1E1E1E", fg="#FFFFFF", font=("Helvetica", 10, "bold")
        ).pack(anchor="w", padx=10, pady=(10, 5))

        entry = tk.Entry(popup, font=("Helvetica", 9), bg="#2D2D2D", fg="#FFFFFF", insertbackground="white")
        entry.insert(0, direct_url)
        entry.pack(fill="x", padx=10, pady=5)

        copy_btn = ttk.Button(
            popup, text="Copy Link to Clipboard",
            command=lambda: [self.root.clipboard_clear(), self.root.clipboard_append(direct_url), popup.destroy()]
        )
        copy_btn.pack(pady=10)

    def _handle_error(self, err_msg):
        self.search_button.config(state="normal")
        self.status_label.config(text="An error occurred.")
        messagebox.showerror("Error", f"Failed to retrieve video details:\n{err_msg}")

    @staticmethod
    def _format_duration(seconds):
        mins, secs = divmod(int(seconds), 60)
        hours, mins = divmod(mins, 60)
        if hours > 0:
            return f"{hours}:{mins:02d}:{secs:02d}"
        return f"{mins}:{secs:02d}"


if __name__ == "__main__":
    root = tk.Tk()
    app = YouTubePlayerApp(root)
    root.mainloop()