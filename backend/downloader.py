import os
import re
import uuid
import yt_dlp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Folder hasil penyimpanan utama: h:\YT-Downloader\hasil
HASIL_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "hasil"))
os.makedirs(HASIL_DIR, exist_ok=True)

# Registry realtime status download: job_id -> status dict
JOBS = {}

# Konfigurasi yt-dlp untuk multi-audio & dubbing
BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "js_runtimes": {"node": {}},
    "remote_components": {"ejs:github"},
    "extractor_args": {
        "youtube": {
            "player_client": ["web_embedded", "web", "android"]
        }
    }
}


def sanitize_filename(name: str) -> str:
    """Membersihkan karakter ilegal dari nama file/folder untuk Windows/Linux."""
    clean = re.sub(r'[\\/*?:"<>|]', "", name)
    clean = clean.strip(". ")
    return clean if clean else "Video_YouTube"


def format_language_label(lang_code: str, note: str) -> str:
    """Membuat label bahasa yang rapi dan mudah dibaca."""
    note_clean = (note or "").replace(", low", "").replace(", medium", "").replace(", high", "").strip()
    if not note_clean:
        return lang_code.upper()
    return note_clean


def get_video_info(url: str) -> dict:
    """
    Mengambil metadata video: judul, thumbnail, durasi,
    daftar resolusi video (video-only murni tanpa audio bawaan),
    dan SEMUA daftar audio track/dubbing.
    """
    ydl_opts = {
        **BASE_YDL_OPTS,
        "skip_download": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    formats = info.get("formats", [])

    video_tracks = []
    audio_tracks = []

    for f in formats:
        vcodec = f.get("vcodec", "none")
        acodec = f.get("acodec", "none")
        format_id = f.get("format_id")
        ext = f.get("ext", "mp4")
        filesize = f.get("filesize") or f.get("filesize_approx") or 0

        # Format Video: Utamakan video-only murni (acodec == "none")
        if vcodec != "none" and acodec == "none":
            height = f.get("height")
            fps = f.get("fps")
            note = f.get("format_note") or ""
            resolution_str = f"{height}p" if height else (f.get("resolution") or "Video")
            if fps and fps > 30:
                resolution_str += f"{fps}"
            if note and "p" not in note.lower():
                resolution_str += f" ({note})"

            video_tracks.append({
                "format_id": format_id,
                "resolution": resolution_str,
                "height": height or 0,
                "ext": ext,
                "fps": fps,
                "vcodec": vcodec,
                "has_audio": False,
                "filesize": filesize,
            })

        # Format Audio-only (Multi-language & Dubbing)
        if acodec != "none" and vcodec == "none":
            lang = f.get("language") or "default"
            raw_note = (
                f.get("language_preference_note")
                or f.get("format_note")
                or f.get("language")
                or "Default Audio"
            )
            label = format_language_label(lang, raw_note)
            abr = f.get("abr") or 0

            audio_tracks.append({
                "format_id": format_id,
                "language": lang,
                "language_name": label,
                "ext": ext,
                "abr": round(abr),
                "acodec": acodec,
                "filesize": filesize,
            })

    # Fallback jika video hanya menyediakan format progressive
    if not video_tracks:
        for f in formats:
            if f.get("vcodec", "none") != "none":
                height = f.get("height")
                video_tracks.append({
                    "format_id": f.get("format_id"),
                    "resolution": f"{height}p" if height else "Default Video",
                    "height": height or 0,
                    "ext": f.get("ext", "mp4"),
                    "fps": f.get("fps"),
                    "vcodec": f.get("vcodec"),
                    "has_audio": True,
                    "filesize": f.get("filesize") or 0,
                })

    # Urutkan resolusi video tertinggi & hilangkan duplikat
    seen_video_keys = set()
    unique_videos = []
    sorted_videos = sorted(
        video_tracks,
        key=lambda x: (x["height"], x["fps"] or 0, x["filesize"]),
        reverse=True
    )
    for v in sorted_videos:
        key = (v["height"], v["fps"], v["ext"])
        if key not in seen_video_keys:
            seen_video_keys.add(key)
            unique_videos.append(v)

    # Deduplikasi audio track per bahasa (pilih bitrate terbaik)
    best_audio_per_lang = {}
    for a in audio_tracks:
        lang_key = a["language"]
        if lang_key not in best_audio_per_lang or a["abr"] > best_audio_per_lang[lang_key]["abr"]:
            best_audio_per_lang[lang_key] = a

    clean_audio_list = list(best_audio_per_lang.values())
    
    # Sort: Bahasa Indonesia / Original di atas, lalu abjad
    def sort_key(item):
        lang = item["language"].lower()
        name = item["language_name"].lower()
        if "id" in lang or "indonesia" in name:
            return (0, name)
        if "original" in name or "default" in name:
            return (1, name)
        return (2, name)

    clean_audio_list.sort(key=sort_key)

    if not clean_audio_list and any(v.get("has_audio") for v in video_tracks):
        clean_audio_list.append({
            "format_id": "bestaudio",
            "language": "default",
            "language_name": "Audio Bawaan (Default)",
            "ext": "m4a",
            "abr": 128,
            "acodec": "aac",
            "filesize": 0,
        })

    return {
        "title": info.get("title", "YouTube Video"),
        "thumbnail": info.get("thumbnail", ""),
        "duration": info.get("duration", 0),
        "uploader": info.get("uploader", ""),
        "view_count": info.get("view_count", 0),
        "video_tracks": unique_videos if unique_videos else video_tracks,
        "audio_tracks": clean_audio_list,
    }


def download_with_selected_tracks(
    url: str,
    video_format_id: str = None,
    audio_format_id: str = None,
    job_id: str = None,
    mode: str = "video"
) -> dict:
    """
    Download video + audio (mode='video') atau ekstraksi audio murni ke MP3 320kbps (mode='mp3').
    Dilengkapi real-time progress hook dan FFmpeg conversion.
    """
    if job_id:
        initial_phase = "PROBING MANIFESTS & STREAMS" if mode == "video" else "PROBING AUDIO STREAMS (MP3 MODE)"
        JOBS[job_id] = {
            "status": "extracting",
            "percent": 5.0,
            "speed": "0.0 MB/s",
            "eta": "--:--",
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "phase": initial_phase,
            "result": None,
            "error": None,
        }

    try:
        # 1. Ambil info judul asli
        with yt_dlp.YoutubeDL({**BASE_YDL_OPTS, "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
            raw_title = info.get("title", "Video_YouTube")
            safe_title = sanitize_filename(raw_title)

        # 2. Buat target direktori: hasil / (Nama Judul Video) /
        target_folder = os.path.join(HASIL_DIR, safe_title)
        os.makedirs(target_folder, exist_ok=True)

        output_template = os.path.join(target_folder, f"{safe_title}.%(ext)s")

        # Progress Hook yt-dlp untuk menangkap persenan, kecepatan, dan sisa waktu
        def yt_progress_hook(d):
            if not job_id or job_id not in JOBS:
                return

            status = d.get("status")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes") or 0
                percent = (downloaded / total * 100) if total > 0 else 0
                speed_bytes = d.get("speed") or 0
                eta_sec = d.get("eta") or 0

                speed_str = f"{speed_bytes / (1024 * 1024):.1f} MB/s" if speed_bytes else (d.get("_speed_str") or "0.0 MB/s")
                if eta_sec:
                    eta_str = f"{int(eta_sec // 60):02d}:{int(eta_sec % 60):02d}"
                else:
                    eta_str = d.get("_eta_str") or "--:--"

                filename = d.get("filename", "")
                if mode in ["mp3", "audio"]:
                    phase_label = "DOWNLOADING HQ AUDIO TRACK (MP3 MODE)"
                else:
                    is_audio = f".f{audio_format_id}." in filename or str(audio_format_id) in filename
                    phase_label = "DOWNLOADING AUDIO TRACK" if is_audio else "DOWNLOADING VIDEO STREAM"

                # Scaling persen download (5% - 85%)
                scaled_percent = 5.0 + (percent * 0.80)

                JOBS[job_id].update({
                    "status": "downloading",
                    "percent": round(scaled_percent, 1),
                    "raw_percent": round(percent, 1),
                    "speed": speed_str.strip(),
                    "eta": eta_str.strip(),
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "phase": phase_label,
                })

            elif status == "finished":
                next_phase = (
                    "STREAM DOWNLOAD COMPLETE • PREPARING FFMPEG MP3 ENCODER"
                    if mode in ["mp3", "audio"]
                    else "STREAM DOWNLOAD COMPLETE • PREPARING FFMPEG"
                )
                JOBS[job_id].update({
                    "status": "muxing",
                    "percent": 88.0,
                    "speed": "FFmpeg",
                    "eta": "00:03",
                    "phase": next_phase,
                })

        def yt_postprocessor_hook(d):
            if not job_id or job_id not in JOBS:
                return

            status = d.get("status")
            if status == "started":
                post_phase = (
                    "FFMPEG CONVERTING AUDIO TO MP3 (320kbps CBR)"
                    if mode in ["mp3", "audio"]
                    else "FFMPEG LOSSLESS MUXING (-map 0:v:0 -map 1:a:0)"
                )
                JOBS[job_id].update({
                    "status": "muxing",
                    "percent": 92.0,
                    "speed": "FFmpeg Core",
                    "eta": "00:02",
                    "phase": post_phase,
                })
            elif status == "finished":
                final_phase = (
                    "EMBEDDING METADATA & WRITING MP3 FILE"
                    if mode in ["mp3", "audio"]
                    else "FINALIZING CONTAINER & WRITING TO DISK"
                )
                JOBS[job_id].update({
                    "status": "finalizing",
                    "percent": 98.0,
                    "speed": "I/O Disk",
                    "eta": "00:01",
                    "phase": final_phase,
                })

        if mode in ["mp3", "audio"]:
            # Mode MP3: Audio-only stream extraction + FFmpeg to MP3 (320kbps)
            format_selector = audio_format_id if audio_format_id and audio_format_id != "none" else "bestaudio"
            final_file_path = os.path.join(target_folder, f"{safe_title}.mp3")

            ydl_opts = {
                **BASE_YDL_OPTS,
                "format": format_selector,
                "outtmpl": output_template,
                "progress_hooks": [yt_progress_hook],
                "postprocessor_hooks": [yt_postprocessor_hook],
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "320",
                    },
                    {
                        "key": "FFmpegMetadata",
                        "add_metadata": True,
                    }
                ],
            }
        else:
            # Mode Video: Dual-stream download + FFmpeg lossless mux to MP4
            format_selector = f"{video_format_id}+{audio_format_id}" if audio_format_id != "none" else video_format_id
            final_file_path = os.path.join(target_folder, f"{safe_title}.mp4")

            ydl_opts = {
                **BASE_YDL_OPTS,
                "format": format_selector,
                "outtmpl": output_template,
                "merge_output_format": "mp4",
                "progress_hooks": [yt_progress_hook],
                "postprocessor_hooks": [yt_postprocessor_hook],
                "postprocessor_args": {
                    "merger": ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac"]
                },
                "postprocessors": [{
                    "key": "FFmpegVideoConvertor",
                    "preferedformat": "mp4",
                }],
            }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        if not os.path.exists(final_file_path):
            expected_ext = ".mp3" if mode in ["mp3", "audio"] else (".mp4", ".mkv", ".webm")
            for fname in os.listdir(target_folder):
                if fname.endswith(expected_ext):
                    final_file_path = os.path.join(target_folder, fname)
                    break

        file_size_bytes = os.path.getsize(final_file_path) if os.path.exists(final_file_path) else 0

        result = {
            "success": True,
            "mode": "mp3" if mode in ["mp3", "audio"] else "video",
            "title": raw_title,
            "filename": os.path.basename(final_file_path),
            "file_path": final_file_path,
            "folder_path": target_folder,
            "file_size": file_size_bytes,
            "format": "MP3 Audio (320 kbps)" if mode in ["mp3", "audio"] else "MPEG-4 (.MP4)",
        }

        if job_id and job_id in JOBS:
            JOBS[job_id].update({
                "status": "finished",
                "percent": 100.0,
                "speed": "COMPLETED",
                "eta": "00:00",
                "phase": "PROCESS COMPLETED (100%)",
                "result": result,
            })

        return result

    except Exception as e:
        err_msg = str(e)
        if job_id and job_id in JOBS:
            JOBS[job_id].update({
                "status": "error",
                "error": err_msg,
                "phase": f"ERROR: {err_msg}",
            })
        raise e
