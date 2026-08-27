# Panduan Komprehensif: YouTube Downloader dengan Pemilihan Audio Track
### Python (yt-dlp + Flask) + FFmpeg + Frontend HTML/CSS/JS

---

## ⚠️ Catatan Penting Sebelum Mulai

- Alat ini dibuat untuk keperluan **edukasi, arsip pribadi, dan konten yang memang diizinkan** (video milik sendiri, konten berlisensi bebas, atau video yang mengizinkan unduhan).
- Mengunduh video berhak cipta tanpa izin dapat melanggar **Terms of Service YouTube** dan hukum hak cipta di negara Anda. Gunakan secara bertanggung jawab.
- Beberapa video memang memiliki **multi-audio track** (misalnya video luar negeri yang di-dubbing ke Bahasa Indonesia oleh kreator/YouTube Auto-Dubbing). Fitur pemilihan track di panduan ini akan mendeteksi dan menampilkan pilihan tersebut jika tersedia di video sumber.

---

## 1. Arsitektur Sistem

```
┌─────────────────────┐        HTTP (REST API)        ┌──────────────────────┐
│   Frontend (Browser) │ ─────────────────────────────▶ │   Backend (Flask)     │
│  HTML + CSS + JS     │ ◀───────────────────────────── │   Python + yt-dlp     │
└─────────────────────┘        JSON / File Stream       └──────────┬───────────┘
                                                                     │
                                                                     ▼
                                                            ┌─────────────────┐
                                                            │  FFmpeg (merge   │
                                                            │  video+audio,    │
                                                            │  convert format) │
                                                            └─────────────────┘
```

**Alur kerja:**
1. User memasukkan URL YouTube di frontend.
2. Frontend memanggil endpoint `/api/formats` untuk mengambil daftar resolusi video dan **audio track** yang tersedia (termasuk bahasa/dubbing).
3. User memilih kombinasi video + audio track yang diinginkan.
4. Frontend mengirim request ke `/api/download` dengan parameter yang dipilih.
5. Backend menjalankan `yt-dlp` untuk mengunduh stream video & audio terpisah, lalu **FFmpeg** menggabungkannya (mux) menjadi satu file output (biasanya `.mp4`).
6. File dikirim kembali ke user (download langsung) atau disimpan lalu diberi link unduhan.

---

## 2. Prasyarat & Instalasi

### 2.1 Software yang dibutuhkan
| Tool | Fungsi | Instalasi |
|---|---|---|
| Python 3.9+ | Menjalankan backend | https://python.org |
| yt-dlp | Ekstraksi info & download stream YouTube | `pip install yt-dlp` |
| FFmpeg | Menggabungkan (mux) video & audio, convert format | Lihat di bawah |
| Flask | Web framework untuk REST API | `pip install flask flask-cors` |

### 2.2 Install FFmpeg

**Windows:**
```bash
winget install ffmpeg
# atau download dari https://ffmpeg.org/download.html dan tambahkan ke PATH
```

**macOS:**
```bash
brew install ffmpeg
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt update && sudo apt install ffmpeg -y
```

Verifikasi instalasi:
```bash
ffmpeg -version
yt-dlp --version
```

### 2.3 Struktur Proyek

```
youtube-downloader/
├── backend/
│   ├── app.py                # Flask API & File Server
│   ├── downloader.py         # Logika yt-dlp, Node.js solver & ffmpeg
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── hasil/                    # Folder penyimpanan utama
│   └── [Nama Judul Video]/  # Folder khusus per video
│       └── [Judul].mp4       # File MP4 hasil gabungan
└── start.bat                 # Script launcher 1-klik Windows
```

---

## 3. Backend: Python + yt-dlp + FFmpeg

### 3.1 `requirements.txt`

```txt
yt-dlp>=2024.1.0
flask>=3.0.0
flask-cors>=4.0.0
```

Install:
```bash
pip install -r requirements.txt
```

### 3.2 `downloader.py` — Logika inti

Bagian ini adalah kunci dari fitur **pemilihan audio track**. yt-dlp mengekspos setiap format sebagai entri terpisah, dan untuk video dengan multi-audio (dubbing), setiap track punya `format_id`, `language`, dan `format_note` (misalnya "Indonesian - original", "English (US)").

```python
# backend/downloader.py
import yt_dlp
import os
import uuid

DOWNLOAD_DIR = os.path.join(os.path.dirname(__file__), "downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def get_video_info(url: str) -> dict:
    """
    Mengambil metadata video: judul, thumbnail, daftar resolusi video,
    dan daftar audio track (termasuk bahasa/dubbing jika tersedia).
    """
    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "no_warnings": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    formats = info.get("formats", [])

    video_tracks = []
    audio_tracks = []

    for f in formats:
        vcodec = f.get("vcodec")
        acodec = f.get("acodec")

        # Format video-only (tanpa audio) -> untuk dipilih resolusinya
        if vcodec != "none" and acodec == "none":
            video_tracks.append({
                "format_id": f["format_id"],
                "resolution": f.get("format_note") or f.get("resolution"),
                "ext": f.get("ext"),
                "fps": f.get("fps"),
                "filesize": f.get("filesize") or f.get("filesize_approx"),
            })

        # Format audio-only -> di sinilah multi-language/dubbing terdeteksi
        if acodec != "none" and vcodec == "none":
            audio_tracks.append({
                "format_id": f["format_id"],
                "language": f.get("language") or "unknown",
                "language_name": (f.get("language_preference_note")
                                   or f.get("format_note")
                                   or f.get("language") or "Default"),
                "ext": f.get("ext"),
                "abr": f.get("abr"),  # audio bitrate
                "is_original": f.get("language_preference", 0) >= 0,
                "filesize": f.get("filesize") or f.get("filesize_approx"),
            })

    # Deduplikasi audio track berdasarkan bahasa (ambil bitrate terbaik per bahasa)
    best_audio_per_lang = {}
    for a in audio_tracks:
        lang = a["language"]
        if lang not in best_audio_per_lang or (a["abr"] or 0) > (best_audio_per_lang[lang]["abr"] or 0):
            best_audio_per_lang[lang] = a

    return {
        "title": info.get("title"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "video_tracks": sorted(video_tracks, key=lambda x: x.get("filesize") or 0, reverse=True),
        "audio_tracks": list(best_audio_per_lang.values()),
    }


def download_with_selected_tracks(url: str, video_format_id: str, audio_format_id: str) -> str:
    """
    Download video track + audio track terpisah, lalu FFmpeg
    otomatis mux (merge) menjadi satu file MP4 (dilakukan oleh yt-dlp
    yang memanggil ffmpeg di balik layar via 'postprocessor').
    """
    file_id = str(uuid.uuid4())
    output_template = os.path.join(DOWNLOAD_DIR, f"{file_id}.%(ext)s")

    # format string ini memberi tahu yt-dlp: ambil format video X + format audio Y
    format_selector = f"{video_format_id}+{audio_format_id}"

    ydl_opts = {
        "format": format_selector,
        "outtmpl": output_template,
        "merge_output_format": "mp4",   # FFmpeg akan menggabungkan ke mp4
        "quiet": True,
        "no_warnings": True,
        # postprocessor FFmpeg untuk memastikan hasil akhir mp4 yang valid
        "postprocessors": [{
            "key": "FFmpegVideoConvertor",
            "preferedformat": "mp4",
        }],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    final_path = os.path.join(DOWNLOAD_DIR, f"{file_id}.mp4")
    return final_path
```

> **Penjelasan teknis:** Saat kamu memberi `format` berupa `"137+251"` (contoh: format video 137 + format audio 251), yt-dlp akan mengunduh **dua file terpisah** lalu memanggil FFmpeg dengan perintah setara:
> ```bash
> ffmpeg -i video.mp4 -i audio_id.m4a -c copy -map 0:v:0 -map 1:a:0 output.mp4
> ```
> `-c copy` berarti tidak ada re-encode (cepat, tanpa kehilangan kualitas), FFmpeg hanya menyatukan container-nya.

### 3.3 `app.py` — REST API

```python
# backend/app.py
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from downloader import get_video_info, download_with_selected_tracks
import os

app = Flask(__name__)
CORS(app)  # izinkan frontend beda origin memanggil API ini


@app.route("/api/formats", methods=["POST"])
def api_formats():
    data = request.get_json()
    url = data.get("url")

    if not url:
        return jsonify({"error": "URL wajib diisi"}), 400

    try:
        info = get_video_info(url)
        return jsonify(info)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/download", methods=["POST"])
def api_download():
    data = request.get_json()
    url = data.get("url")
    video_format_id = data.get("video_format_id")
    audio_format_id = data.get("audio_format_id")

    if not all([url, video_format_id, audio_format_id]):
        return jsonify({"error": "Parameter tidak lengkap"}), 400

    try:
        filepath = download_with_selected_tracks(url, video_format_id, audio_format_id)
        return send_file(filepath, as_attachment=True, download_name=os.path.basename(filepath))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
```

Jalankan backend:
```bash
cd backend
python app.py
# Server berjalan di http://localhost:5000
```

---

## 4. Frontend: HTML + CSS + JS

### 4.1 `index.html`

```html
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Downloader — Multi Audio Track</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <h1>YouTube Downloader</h1>
    <p class="subtitle">Pilih resolusi video & audio track (bahasa) secara terpisah</p>

    <div class="input-group">
      <input type="text" id="urlInput" placeholder="Tempel link YouTube di sini...">
      <button id="fetchBtn">Cek Video</button>
    </div>

    <div id="loading" class="hidden">🔄 Mengambil data video...</div>
    <div id="errorBox" class="error hidden"></div>

    <div id="result" class="hidden">
      <div class="video-preview">
        <img id="thumbnail" src="" alt="thumbnail">
        <div>
          <h3 id="videoTitle"></h3>
          <span id="videoDuration"></span>
        </div>
      </div>

      <div class="select-group">
        <label for="videoSelect">🎞️ Resolusi Video</label>
        <select id="videoSelect"></select>
      </div>

      <div class="select-group">
        <label for="audioSelect">🔊 Audio Track / Bahasa</label>
        <select id="audioSelect"></select>
      </div>

      <button id="downloadBtn">⬇️ Download</button>
      <div id="downloadStatus"></div>
    </div>
  </div>

  <script src="script.js"></script>
</body>
</html>
```

### 4.2 `style.css`

```css
* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; }

body {
  background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.container {
  background: #ffffff0d;
  backdrop-filter: blur(10px);
  border: 1px solid #ffffff1a;
  border-radius: 16px;
  padding: 32px;
  width: 100%;
  max-width: 520px;
  color: #fff;
}

h1 { font-size: 24px; margin-bottom: 4px; }
.subtitle { color: #cfcfe8; font-size: 13px; margin-bottom: 20px; }

.input-group { display: flex; gap: 8px; margin-bottom: 16px; }

#urlInput {
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #ffffff33;
  background: #ffffff10;
  color: #fff;
  outline: none;
}

button {
  padding: 12px 18px;
  border: none;
  border-radius: 8px;
  background: #7f5af0;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  transition: 0.2s;
}
button:hover { background: #6c4ce0; }

.hidden { display: none; }

.error {
  background: #ff4b4b22;
  border: 1px solid #ff4b4b;
  color: #ffb3b3;
  padding: 10px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
}

.video-preview {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 20px;
}
.video-preview img { width: 120px; border-radius: 8px; }
.video-preview h3 { font-size: 14px; margin-bottom: 4px; }
.video-preview span { font-size: 12px; color: #cfcfe8; }

.select-group { margin-bottom: 14px; }
.select-group label { display: block; font-size: 13px; margin-bottom: 6px; color: #cfcfe8; }
.select-group select {
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  background: #ffffff10;
  color: #fff;
  border: 1px solid #ffffff33;
}
.select-group select option { color: #000; }

#downloadBtn { width: 100%; margin-top: 6px; }
#downloadStatus { margin-top: 12px; font-size: 13px; color: #cfcfe8; text-align: center; }
```

### 4.3 `script.js`

```javascript
const API_BASE = "http://localhost:5000/api";

const urlInput = document.getElementById("urlInput");
const fetchBtn = document.getElementById("fetchBtn");
const loading = document.getElementById("loading");
const errorBox = document.getElementById("errorBox");
const result = document.getElementById("result");

const thumbnail = document.getElementById("thumbnail");
const videoTitle = document.getElementById("videoTitle");
const videoDuration = document.getElementById("videoDuration");
const videoSelect = document.getElementById("videoSelect");
const audioSelect = document.getElementById("audioSelect");
const downloadBtn = document.getElementById("downloadBtn");
const downloadStatus = document.getElementById("downloadStatus");

let currentUrl = "";

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
}

function resetUI() {
  errorBox.classList.add("hidden");
  result.classList.add("hidden");
}

function formatSize(bytes) {
  if (!bytes) return "ukuran tidak diketahui";
  const mb = bytes / (1024 * 1024);
  return mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

fetchBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return showError("Masukkan URL YouTube terlebih dahulu.");

  resetUI();
  loading.classList.remove("hidden");
  currentUrl = url;

  try {
    const res = await fetch(`${API_BASE}/formats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    loading.classList.add("hidden");

    if (!res.ok) return showError(data.error || "Terjadi kesalahan.");

    // Isi preview
    thumbnail.src = data.thumbnail;
    videoTitle.textContent = data.title;
    videoDuration.textContent = formatDuration(data.duration);

    // Isi dropdown video
    videoSelect.innerHTML = data.video_tracks.map(v =>
      `<option value="${v.format_id}">${v.resolution} (${v.ext}, ${formatSize(v.filesize)})</option>`
    ).join("");

    // Isi dropdown audio -> di sinilah pilihan bahasa/dubbing muncul
    audioSelect.innerHTML = data.audio_tracks.map(a =>
      `<option value="${a.format_id}">${a.language_name} — ${a.language} (${Math.round(a.abr || 0)}kbps)</option>`
    ).join("");

    result.classList.remove("hidden");
  } catch (err) {
    loading.classList.add("hidden");
    showError("Gagal terhubung ke server backend. Pastikan backend berjalan.");
  }
});

downloadBtn.addEventListener("click", async () => {
  const video_format_id = videoSelect.value;
  const audio_format_id = audioSelect.value;

  downloadStatus.textContent = "⏳ Sedang mengunduh & menggabungkan video+audio, mohon tunggu...";
  downloadBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl, video_format_id, audio_format_id }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Gagal mengunduh video.");
    }

    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `${videoTitle.textContent}.mp4`;
    a.click();

    downloadStatus.textContent = "✅ Selesai! File berhasil diunduh.";
  } catch (err) {
    downloadStatus.textContent = `❌ ${err.message}`;
  } finally {
    downloadBtn.disabled = false;
  }
});
```

---

## 5. Cara Menjalankan Aplikasi

1. **Jalankan backend:**
   ```bash
   cd backend
   pip install -r requirements.txt
   python app.py
   ```
2. **Buka frontend:** buka file `frontend/index.html` langsung di browser, atau serve dengan live server (VS Code extension "Live Server") supaya request `fetch` berjalan lancar.
3. Tempel URL video YouTube yang punya banyak audio track (contoh: video dokumenter luar negeri yang di-dubbing Bahasa Indonesia oleh YouTube).
4. Klik **Cek Video** → pilih resolusi & audio track (misalnya "Indonesian") → klik **Download**.

---

## 6. Cara Mendeteksi Video yang Punya Multi-Audio Track

Tidak semua video punya banyak audio track. Untuk mengecek manual via terminal sebelum ngoding:

```bash
yt-dlp -F "URL_VIDEO"
```

Perhatikan kolom terakhir (`MORE INFO`) — video dengan multi-audio biasanya menampilkan beberapa baris format audio-only dengan keterangan bahasa berbeda, contoh:

```
251-0  webm  audio only  medium, opus @128k, original (English)
251-1  webm  audio only  medium, opus @128k, Indonesian
```

Field `language` pada JSON metadata (`f.get("language")`) akan berisi kode seperti `id` (Indonesia), `en` (English), dsb — inilah yang digunakan pada `downloader.py` untuk mengelompokkan track.

---

## 7. Pengembangan Lanjutan (Opsional)

| Fitur | Cara implementasi singkat |
|---|---|
| Progress bar real-time | Gunakan `progress_hooks` di yt-dlp opts + WebSocket/Server-Sent Events ke frontend |
| Download audio saja (MP3) | `postprocessors: [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3"}]` |
| Batch/playlist download | Deteksi `info["_type"] == "playlist"`, loop tiap entry |
| Antrian download | Gunakan Celery + Redis agar tidak blocking request Flask |
| Docker deployment | Buat `Dockerfile` yang install `ffmpeg` via `apt-get` + copy backend |
| Rate limiting | Gunakan `flask-limiter` agar API tidak disalahgunakan |
| Autentikasi/login | Tambahkan JWT jika ingin membatasi siapa yang boleh download |

Contoh cepat `progress_hooks` untuk melihat kemajuan proses download di terminal backend:

```python
def progress_hook(d):
    if d["status"] == "downloading":
        print(f"Progress: {d.get('_percent_str')} - {d.get('_eta_str')}")

ydl_opts["progress_hooks"] = [progress_hook]
```

---

## 8. Troubleshooting Umum

| Masalah | Penyebab | Solusi |
|---|---|---|
| `ffmpeg not found` | FFmpeg belum terinstall/tidak di PATH | Install ulang & pastikan `ffmpeg -version` bisa dijalankan dari terminal |
| Audio track hanya muncul 1 (default) | Video sumber memang tidak punya dubbing | Cek dulu dengan `yt-dlp -F` |
| CORS error di browser | Frontend & backend beda origin tanpa header CORS | Pastikan `flask-cors` terpasang dan `CORS(app)` dipanggil |
| Download lambat | Koneksi/parallel fragment kurang optimal | Tambahkan `"concurrent_fragment_downloads": 4` di `ydl_opts` |
| Error 403 dari YouTube | Perubahan sistem internal YouTube | Update yt-dlp: `pip install -U yt-dlp` (proyek ini sering update mengikuti perubahan YouTube) |

---

## 9. Ringkasan

Dokumen ini mencakup arsitektur lengkap, backend Python (Flask + yt-dlp) yang mampu **memisahkan dan menampilkan setiap audio track/bahasa** yang tersedia pada video (termasuk dubbing Indonesia pada video luar negeri), proses **muxing dengan FFmpeg**, serta frontend HTML/CSS/JS interaktif untuk memilih kombinasi video+audio sebelum mengunduh. Kombinasi `yt-dlp` (ekstraksi & pemilihan stream) + `ffmpeg` (penggabungan container tanpa re-encode) adalah pendekatan standar dan paling efisien untuk kasus ini.