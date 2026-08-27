import os
import json
import time
import uuid
import threading
import subprocess
from flask import Flask, request, jsonify, send_file, send_from_directory, Response
from flask_cors import CORS
from downloader import get_video_info, download_with_selected_tracks, HASIL_DIR, JOBS

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))

app = Flask(__name__, static_folder=FRONTEND_DIR)
CORS(app)


# Pembersihan otomatis job registry lama
def cleanup_old_jobs():
    while True:
        try:
            time.sleep(300)
            # Batasi ukuran registry jika lebih dari 100 job
            if len(JOBS) > 100:
                keys = list(JOBS.keys())[:50]
                for k in keys:
                    JOBS.pop(k, None)
        except Exception:
            pass


cleanup_thread = threading.Thread(target=cleanup_old_jobs, daemon=True)
cleanup_thread.start()


# Serve Frontend
@app.route("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def serve_static(path):
    if os.path.exists(os.path.join(FRONTEND_DIR, path)):
        return send_from_directory(FRONTEND_DIR, path)
    return send_from_directory(FRONTEND_DIR, "index.html")


# REST API Endpoints
@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "message": "YouTube Downloader API is running",
        "hasil_dir": HASIL_DIR
    })


@app.route("/api/formats", methods=["POST"])
def api_formats():
    data = request.get_json() or {}
    url = data.get("url", "").strip()

    if not url:
        return jsonify({"error": "URL YouTube wajib diisi."}), 400

    try:
        info = get_video_info(url)
        return jsonify(info)
    except Exception as e:
        return jsonify({"error": f"Gagal mengekstrak info video: {str(e)}"}), 500


@app.route("/api/download", methods=["POST"])
def api_download():
    """
    Memulai proses download/convert di background thread dan langsung mengembalikan job_id
    agar frontend dapat mendengarkan progres real-time via SSE.
    """
    data = request.get_json() or {}
    url = data.get("url", "").strip()
    mode = data.get("mode", "video")  # 'video' atau 'mp3'
    video_format_id = data.get("video_format_id")
    audio_format_id = data.get("audio_format_id")

    if not url:
        return jsonify({"error": "URL YouTube wajib diisi."}), 400

    if mode == "video" and (not video_format_id or not audio_format_id):
        return jsonify({"error": "Parameter url, video_format_id, dan audio_format_id wajib diisi untuk mode video."}), 400

    if mode in ["mp3", "audio"] and not audio_format_id:
        audio_format_id = "bestaudio"

    job_id = str(uuid.uuid4())

    def worker():
        try:
            download_with_selected_tracks(
                url=url,
                video_format_id=video_format_id,
                audio_format_id=audio_format_id,
                job_id=job_id,
                mode=mode
            )
        except Exception as err:
            print(f"[Worker Error] Job {job_id}: {err}")

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    return jsonify({
        "status": "queued",
        "job_id": job_id,
        "mode": mode
    })


@app.route("/api/progress/<job_id>", methods=["GET"])
def api_progress(job_id):
    """Snapshot progres berkala untuk polling fallback."""
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job tidak ditemukan."}), 404
    return jsonify(job)


@app.route("/api/progress-stream/<job_id>", methods=["GET"])
def api_progress_stream(job_id):
    """
    Server-Sent Events (SSE) stream untuk mengirim update persenan,
    kecepatan download, dan ETA secara real-time ke frontend.
    """
    def event_stream():
        last_payload = None
        while True:
            job = JOBS.get(job_id)
            if not job:
                yield f"data: {json.dumps({'status': 'waiting', 'percent': 0})}\n\n"
                time.sleep(0.5)
                continue

            payload_str = json.dumps(job)
            if payload_str != last_payload:
                yield f"data: {payload_str}\n\n"
                last_payload = payload_str

            if job.get("status") in ["finished", "error"]:
                break

            time.sleep(0.2)

    return Response(
        event_stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
    )


@app.route("/api/open-folder", methods=["POST"])
def api_open_folder():
    """Membuka folder hasil download di Windows File Explorer."""
    data = request.get_json() or {}
    path = data.get("path") or HASIL_DIR

    try:
        norm_path = os.path.normpath(path)
        if not os.path.exists(norm_path):
            norm_path = HASIL_DIR

        if os.name == "nt":  # Windows
            if os.path.isfile(norm_path):
                subprocess.Popen(f'explorer /select,"{norm_path}"')
            else:
                os.startfile(norm_path)
            return jsonify({"status": "ok", "message": "Folder berhasil dibuka di File Explorer."})
        elif os.name == "posix":  # Linux / macOS
            subprocess.Popen(["xdg-open", norm_path])
            return jsonify({"status": "ok", "message": "Folder dibuka."})
        else:
            return jsonify({"error": "Sistem operasi tidak didukung."}), 400
    except Exception as e:
        return jsonify({"error": f"Gagal membuka folder: {str(e)}"}), 500


@app.route("/api/stream-file", methods=["GET"])
def api_stream_file():
    """Mengunduh file langsung ke browser jika diperlukan."""
    file_path = request.args.get("path")
    if file_path and os.path.exists(file_path):
        mime_type = "audio/mpeg" if file_path.lower().endswith(".mp3") else "video/mp4"
        return send_file(
            file_path,
            as_attachment=True,
            download_name=os.path.basename(file_path),
            mimetype=mime_type
        )
    return jsonify({"error": "File tidak ditemukan"}), 404


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"==================================================")
    print(f"🚀 YouTube Downloader Server berjalan di:")
    print(f"👉 http://localhost:{port}")
    print(f"📁 Folder Penyimpanan Hasil:")
    print(f"👉 {HASIL_DIR}")
    print(f"==================================================")
    app.run(host="0.0.0.0", port=port, debug=True)
