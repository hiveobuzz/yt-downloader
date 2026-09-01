const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ========================================================
// KONFIGURASI BACKEND RAILWAY (DEFAULT)
// ========================================================
const DEFAULT_RAILWAY_URL = "https://yt-downloader-production-1051.up.railway.app";


// Helper Functions
function formatDuration(seconds) {
  if (!seconds) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0.0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function sanitizeForPreview(name) {
  if (!name) return "Video_Output";
  return name.replace(/[\\/*?:"<>|]/g, "").trim();
}

function App() {
  const [backendUrl, setBackendUrl] = useState(() => {
    return localStorage.getItem("YT_BACKEND_URL") || DEFAULT_RAILWAY_URL;
  });
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [backendHealth, setBackendHealth] = useState({ status: "checking", message: "Memeriksa..." });

  const [url, setUrl] = useState("");
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [videoData, setVideoData] = useState(null);

  const [mode, setMode] = useState("video"); // 'video' | 'mp3'
  const [selectedVideoFormat, setSelectedVideoFormat] = useState("");
  const [selectedAudioFormat, setSelectedAudioFormat] = useState("");

  // Download & Telemetry state
  const [isDownloading, setIsDownloading] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [telemetry, setTelemetry] = useState({
    status: "idle",
    percent: 0,
    speed: "0.0 MB/s",
    eta: "--:--",
    phase: "",
    downloaded_bytes: 0,
    total_bytes: 0
  });
  const [downloadResult, setDownloadResult] = useState(null);

  const eventSourceRef = useRef(null);
  const pollIntervalRef = useRef(null);

  // Compute API_BASE (Auto add https:// jika belum ada)
  const apiBase = useMemo(() => {
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    if (backendUrl && backendUrl.trim()) {
      let clean = backendUrl.trim().replace(/\/+$/, "");
      if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
        clean = "https://" + clean;
      }
      return clean + "/api";
    }
    if (isLocal) {
      return window.location.port === "5000" ? "/api" : "http://localhost:5000/api";
    }
    return "/api";
  }, [backendUrl]);

  const isLocalEnvironment = useMemo(() => {
    return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  }, []);

  // Check Backend Health
  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/health`);
      const data = await res.json();
      if (res.ok && data.status === "ok") {
        setBackendHealth({
          status: "online",
          message: data.environment === "cloud" ? "CLOUD: RAILWAY" : "LOCAL: PORT 5000",
          environment: data.environment || "local"
        });
      } else {
        setBackendHealth({ status: "error", message: "ERR: BACKEND" });
      }
    } catch (e) {
      setBackendHealth({ status: "offline", message: "OFFLINE" });
    }
  }, [apiBase]);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  // Clean up SSE and Polling on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // Paste from clipboard
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
      }
    } catch (e) {
      console.warn("Clipboard access denied:", e);
    }
  };

  // Analyze URL / Extract Formats
  const handleExtract = async (e) => {
    if (e) e.preventDefault();
    if (!url.trim()) {
      setErrorMessage("Input error: YouTube stream URL cannot be empty.");
      return;
    }

    setErrorMessage("");
    setIsLoadingInfo(true);
    setVideoData(null);
    setDownloadResult(null);
    setTelemetry({ status: "idle", percent: 0, speed: "0.0 MB/s", eta: "--:--", phase: "" });

    try {
      const res = await fetch(`${apiBase}/formats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to extract video stream manifests from YouTube.");
      }

      setVideoData(data);
      // Auto select best video track
      if (data.video_tracks && data.video_tracks.length > 0) {
        setSelectedVideoFormat(data.video_tracks[0].format_id);
      }
      // Auto select best audio track
      if (data.audio_tracks && data.audio_tracks.length > 0) {
        setSelectedAudioFormat(data.audio_tracks[0].format_id);
      }
    } catch (err) {
      setErrorMessage(err.message || "Failed to communicate with yt-dlp backend. Verify network connection and URL format.");
    } finally {
      setIsLoadingInfo(false);
    }
  };

  // Start Download
  const handleDownload = async () => {
    if (!url.trim()) return;
    if (mode === "video" && (!selectedVideoFormat || !selectedAudioFormat)) {
      setErrorMessage("Parameter url, video_format_id, and audio_format_id are required for video mode.");
      return;
    }

    setErrorMessage("");
    setIsDownloading(true);
    setDownloadResult(null);
    setTelemetry({
      status: "extracting",
      percent: 5,
      speed: "0.0 MB/s",
      eta: "--:--",
      phase: mode === "mp3" ? "PROBING AUDIO STREAMS (MP3 MODE)" : "PROBING MANIFESTS & STREAMS",
      downloaded_bytes: 0,
      total_bytes: 0
    });

    try {
      const res = await fetch(`${apiBase}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          mode: mode,
          video_format_id: selectedVideoFormat,
          audio_format_id: selectedAudioFormat || "bestaudio"
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Gagal memulai job unduhan.");
      }

      const activeJobId = data.job_id;
      setJobId(activeJobId);
      listenToProgress(activeJobId);

    } catch (err) {
      setErrorMessage(err.message || "Failed to start download process.");
      setIsDownloading(false);
    }
  };

  // Listen to Progress via SSE with Polling Fallback
  const listenToProgress = (activeJobId) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    if (window.EventSource) {
      const sse = new EventSource(`${apiBase}/progress-stream/${activeJobId}`);
      eventSourceRef.current = sse;

      sse.onmessage = (event) => {
        try {
          const job = JSON.parse(event.data);
          setTelemetry(job);

          if (job.status === "finished") {
            sse.close();
            setIsDownloading(false);
            setDownloadResult(job.result);
          } else if (job.status === "error") {
            sse.close();
            setIsDownloading(false);
            setErrorMessage(job.error || "Proses unduhan mengalami kegagalan.");
          }
        } catch (e) {
          console.error("SSE parse error:", e);
        }
      };

      sse.onerror = () => {
        sse.close();
        startPolling(activeJobId);
      };
    } else {
      startPolling(activeJobId);
    }
  };

  // Fallback Polling
  const startPolling = (activeJobId) => {
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase}/progress/${activeJobId}`);
        if (!res.ok) return;
        const job = await res.json();
        setTelemetry(job);

        if (job.status === "finished") {
          clearInterval(pollIntervalRef.current);
          setIsDownloading(false);
          setDownloadResult(job.result);
        } else if (job.status === "error") {
          clearInterval(pollIntervalRef.current);
          setIsDownloading(false);
          setErrorMessage(job.error || "Proses unduhan gagal.");
        }
      } catch (e) {
        console.warn("Polling error:", e);
      }
    }, 300);
  };

  // Open Explorer Folder (Local)
  const handleOpenFolder = async (path = "") => {
    if (!isLocalEnvironment) {
      alert("Backend berjalan di Cloud Server (Railway). File hasil download dapat langsung disimpan ke perangkat menggunakan tombol unduh.");
      return;
    }
    try {
      const res = await fetch(`${apiBase}/open-folder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Gagal membuka File Explorer.");
      }
    } catch (e) {
      alert("Gagal menghubungi server untuk membuka File Explorer.");
    }
  };

  // Direct Browser Stream Download
  const handleStreamDownload = () => {
    if (!downloadResult || !downloadResult.file_path) return;
    const downloadUrl = `${apiBase}/stream-file?path=${encodeURIComponent(downloadResult.file_path)}`;
    window.location.href = downloadUrl;
  };

  // Compute storage preview text
  const previewPathText = useMemo(() => {
    if (!videoData) return "-";
    const safeName = sanitizeForPreview(videoData.title);
    const ext = mode === "mp3" ? "mp3" : "mp4";
    if (isLocalEnvironment) {
      return `hasil\\${safeName}\\${safeName}.${ext}`;
    }
    return `Cloud Buffer: /tmp/hasil/${safeName}.${ext} (Direct Browser Download)`;
  }, [videoData, mode, isLocalEnvironment]);

  // Telemetry Step Statuses
  const stepStatuses = useMemo(() => {
    const p = telemetry.percent || 0;
    return {
      step1: p >= 5 ? (p > 15 ? "step-done" : "step-active") : "",
      step2: p >= 15 ? (p >= 85 ? "step-done" : "step-active") : "",
      step3: p >= 85 ? (p >= 98 ? "step-done" : "step-active") : "",
      step4: p >= 98 ? "step-done" : ""
    };
  }, [telemetry.percent]);

  return (
    <div className="app-shell">
      
      {/* Top System Telemetry Bar */}
      <header className="sys-header">
        <div className="sys-brand">
          <div className="sys-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9.5" />
              <circle cx="12" cy="12" r="3" />
              <circle cx="12" cy="5.5" r="1.25" fill="currentColor" />
              <circle cx="17.63" cy="15.25" r="1.25" fill="currentColor" />
              <circle cx="6.37" cy="15.25" r="1.25" fill="currentColor" />
              <line x1="12" y1="2.5" x2="12" y2="4.25" />
              <line x1="20.22" y1="16.75" x2="18.7" y2="15.88" />
              <line x1="3.78" y1="16.75" x2="5.3" y2="15.88" />
            </svg>
          </div>
          <div className="sys-title-group">
            <div className="sys-title">
              <span>YT STREAM EXTRACTOR</span>
              <span className="sys-tag">REACT v3.0</span>
            </div>
            <div className="sys-sub">yt-dlp Engine • FFmpeg Muxer • Multi-Audio Matrix</div>
          </div>
        </div>

        <div className="sys-status-bar">
          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="btn-terminal-sm"
            title="Klik untuk konfigurasi URL Server Railway"
          >
            <span className={`status-led ${backendHealth.status === 'online' ? 'led-active' : 'led-pulse'}`} />
            <span>{backendHealth.message}</span>
          </button>

          {isLocalEnvironment && (
            <button
              type="button"
              onClick={() => handleOpenFolder("")}
              className="btn-terminal-sm"
              title="Buka folder root penyimpanan di Windows File Explorer"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M3 6h6l2 2.5h10v10.5H3V6z" />
                <line x1="3" y1="11" x2="21" y2="11" />
              </svg>
              <span>ROOT: /hasil</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Workspace Matrix */}
      <main className="workspace-card">
        
        {/* Section 1: URL Intake Terminal */}
        <div className="intake-section">
          <div className="section-label-bar">
            <span className="section-num">01</span>
            <span className="section-title">TARGET URL STREAM</span>
            <span className="section-meta">FORMAT: HTTPS://YOUTUBE.COM/WATCH?V=...</span>
          </div>

          <form onSubmit={handleExtract} className="cli-input-bar">
            <div className="cli-prompt-symbol">&gt;_</div>
            <input
              type="url"
              id="urlInput"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste YouTube Video / Shorts URL here..."
              autoComplete="off"
              spellCheck="false"
              disabled={isLoadingInfo || isDownloading}
            />
            <button
              type="button"
              onClick={handlePaste}
              className="btn-cli-addon"
              title="Paste dari Clipboard"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <rect x="8" y="2" width="8" height="4" rx="0.5" />
                <path d="M16 4h3v17H5V4h3" />
                <line x1="9" y1="10" x2="15" y2="10" />
                <line x1="9" y1="14" x2="13" y2="14" />
              </svg>
              <span>PASTE</span>
            </button>
            <button
              type="submit"
              disabled={isLoadingInfo || isDownloading || !url.trim()}
              className="btn-solid-accent"
            >
              {isLoadingInfo ? (
                <span>ANALYZING...</span>
              ) : (
                <>
                  <span>EXTRACT METRICS</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="4" y1="12" x2="20" y2="12" />
                    <polyline points="14 6 20 12 14 18" />
                  </svg>
                </>
              )}
            </button>
          </form>
        </div>

        {/* State: Loading Telemetry */}
        {isLoadingInfo && (
          <div id="loadingState" className="terminal-loader">
            <div className="loader-terminal-box">
              <div className="loader-head">
                <span className="mono-prompt">[yt-dlp::probe]</span>
                <span className="loader-phase">FETCHING MANIFEST &amp; DUBBING TRACKS...</span>
              </div>
              <div className="loader-bar-track">
                <div className="loader-bar-fill" />
              </div>
              <div className="loader-sub mono-text">Running Node.js EJS challenge solver • Querying web_embedded client stream map...</div>
            </div>
          </div>
        )}

        {/* State: Error Console */}
        {errorMessage && (
          <div id="errorState" className="terminal-error-card">
            <div className="error-header-row">
              <div className="error-badge">ERROR 500</div>
              <span id="errorTitle" className="error-title-text">FAILED TO EXTRACT STREAMS</span>
            </div>
            <pre id="errorMessage" className="error-trace-log">{errorMessage}</pre>
          </div>
        )}

        {/* Section 2: Results & Demux Matrix */}
        {videoData && (
          <div id="resultSection" className="matrix-section">
            
            {/* Video Telemetry Header */}
            <div className="video-meta-grid">
              <div className="thumb-frame">
                <img id="videoThumb" src={videoData.thumbnail} alt={videoData.title} />
                <div className="thumb-corner-overlay">
                  <span id="videoDuration" className="mono-tag-time">{formatDuration(videoData.duration)}</span>
                </div>
              </div>
              <div className="video-details">
                <div>
                  <div className="meta-channel-row">
                    <span className="channel-label">CHANNEL:</span>
                    <span id="videoAuthor" className="channel-name">{videoData.uploader || "YouTube Creator"}</span>
                  </div>
                  <h2 id="videoTitle" className="video-heading">{videoData.title}</h2>
                </div>
                <div className="stream-stats-bar">
                  <div className="stat-cell">
                    <span className="stat-label">AUDIO DUBBING</span>
                    <span id="audioTracksCount" className="stat-value text-accent">
                      {videoData.audio_tracks ? videoData.audio_tracks.length : 0} Tracks
                    </span>
                  </div>
                  <div className="stat-cell">
                    <span className="stat-label">VIDEO STREAMS</span>
                    <span id="videoTracksCount" className="stat-value">
                      {videoData.video_tracks ? videoData.video_tracks.length : 0} Options
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 3: Stream Selection Matrix & Mode Switcher */}
            <div className="track-selector-section">
              <div className="section-label-bar">
                <span className="section-num">02</span>
                <span className="section-title">STREAM DEMUX &amp; MATRIX</span>
                <span id="matrixSectionMeta" className="section-meta">
                  {mode === "mp3" ? "MODE: AUDIO ONLY (MP3) • 320 KBPS CONVERSION" : "SELECT DESIRED STREAM COMBINATION"}
                </span>
              </div>

              {/* Mode Switcher Tabs */}
              <div className="mode-tabs-bar">
                <div
                  id="modeVideoBtn"
                  onClick={() => setMode("video")}
                  className={`mode-tab-item ${mode === "video" ? "active" : ""}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                    <line x1="7" y1="4" x2="7" y2="20" />
                    <line x1="17" y1="4" x2="17" y2="20" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                  </svg>
                  <div className="mode-tab-content">
                    <span className="mode-tab-name">VIDEO + DUBBING</span>
                    <span className="mode-tab-desc">Lossless merge video stream &amp; custom audio track (MP4)</span>
                  </div>
                </div>

                <div
                  id="modeAudioBtn"
                  onClick={() => setMode("mp3")}
                  className={`mode-tab-item ${mode === "mp3" ? "active" : ""}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                  <div className="mode-tab-content">
                    <span className="mode-tab-name">AUDIO HQ (MP3)</span>
                    <span className="mode-tab-desc">Ekstrak audio murni kualitas tinggi 320 kbps (MP3)</span>
                  </div>
                </div>
              </div>

              {/* Selector Grid */}
              <div id="selectorGrid" className={`selector-grid ${mode === "mp3" ? "audio-only-mode" : ""}`}>
                
                {/* Video Selector Box (Video Mode Only) */}
                {mode === "video" && (
                  <div id="videoSelectorBox" className="selector-box">
                    <div className="box-header">
                      <svg className="box-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                      </svg>
                      <div className="box-header-text">
                        <span className="box-title">VIDEO STREAM RESOLUTION</span>
                        <span className="box-desc">Video stream murni tanpa audio bawaan (Video-only)</span>
                      </div>
                    </div>
                    <div className="custom-select-container">
                      <select
                        id="videoSelect"
                        value={selectedVideoFormat}
                        onChange={(e) => setSelectedVideoFormat(e.target.value)}
                        disabled={isDownloading}
                        className="matrix-select"
                      >
                        {videoData.video_tracks && videoData.video_tracks.map((v) => (
                          <option key={v.format_id} value={v.format_id}>
                            {v.resolution} ({v.fps ? `${v.fps}fps` : ''}) • {v.ext.toUpperCase()} • {formatBytes(v.filesize)}
                          </option>
                        ))}
                      </select>
                      <span className="select-chevron">&#9662;</span>
                    </div>
                  </div>
                )}

                {/* Audio Selector Box */}
                <div id="audioSelectorBox" className="selector-box">
                  <div className="box-header">
                    <svg className="box-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                    <div className="box-header-text">
                      <span id="audioBoxTitle" className="box-title">
                        {mode === "mp3" ? "AUDIO TRACK TO CONVERT TO MP3" : "AUDIO DUBBING TRACK"}
                      </span>
                      <span id="audioBoxDesc" className="box-desc">
                        {mode === "mp3" ? "Pilih track bahasa / dubbing sumber yang ingin dikonversi ke MP3 320kbps" : "Pilih dubbing bahasa untuk digabung ke video"}
                      </span>
                    </div>
                  </div>
                  <div className="custom-select-container">
                    <select
                      id="audioSelect"
                      value={selectedAudioFormat}
                      onChange={(e) => setSelectedAudioFormat(e.target.value)}
                      disabled={isDownloading}
                      className="matrix-select"
                    >
                      {videoData.audio_tracks && videoData.audio_tracks.map((a) => (
                        <option key={a.format_id} value={a.format_id}>
                          {a.language_name} ({a.language ? a.language.toUpperCase() : "DEF"}) • {a.abr ? `${Math.round(a.abr)}kbps` : "HQ"} • {a.ext}
                        </option>
                      ))}
                    </select>
                    <span className="select-chevron">&#9662;</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Storage Console */}
            <div className="storage-console">
              <div className="console-label-row">
                <span className="console-badge">[TARGET]</span>
                <span className="console-heading">TARGET DESTINATION / DISK BUFFER:</span>
              </div>
              <div className="console-path-display">
                <span className="console-prefix">&gt;</span>
                <span id="targetFolderPreview" className="console-path-text">{previewPathText}</span>
              </div>
            </div>

            {/* Section 5: Execution Action */}
            <div className="execution-bar">
              <button
                type="button"
                id="downloadBtn"
                onClick={handleDownload}
                disabled={isDownloading}
                className="btn-execute"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span id="downloadBtnText">
                  {isDownloading ? "PROCESSING DOWNLOAD & MUXING PIPELINE..." : "EXECUTE DOWNLOAD & MUXING PIPELINE"}
                </span>
              </button>
            </div>

            {/* Section 6: Telemetry & Progress Console */}
            {isDownloading && (
              <div id="downloadStatusBox" className="telemetry-progress-console">
                <div className="telemetry-header">
                  <div className="telemetry-title-group">
                    <div className="status-led led-pulse" />
                    <span id="statusMessage" className="telemetry-status-text">
                      {telemetry.phase || "INITIALIZING DOWNLOAD PIPELINE..."}
                    </span>
                  </div>
                  <div className="telemetry-percent-box">
                    <span id="telemetryPercent" className="telemetry-percent-value">
                      {Math.round(telemetry.percent || 0)}%
                    </span>
                  </div>
                </div>

                <div className="pipeline-steps">
                  <div id="step1" className={`pipeline-step ${stepStatuses.step1}`}>
                    <span className="step-dot" />
                    <span>1. PROBE</span>
                  </div>
                  <div id="step2" className={`pipeline-step ${stepStatuses.step2}`}>
                    <span className="step-dot" />
                    <span>2. DOWNLOAD</span>
                  </div>
                  <div id="step3" className={`pipeline-step ${stepStatuses.step3}`}>
                    <span className="step-dot" />
                    <span>3. FFMPEG MUX</span>
                  </div>
                  <div id="step4" className={`pipeline-step ${stepStatuses.step4}`}>
                    <span className="step-dot" />
                    <span>4. READY</span>
                  </div>
                </div>

                <div className="functional-progress-track">
                  <div
                    id="progressBar"
                    className="functional-progress-bar"
                    style={{ width: `${Math.min(Math.max(telemetry.percent || 0, 3), 100)}%` }}
                  />
                </div>

                <div className="telemetry-metrics-grid">
                  <div className="metric-item">
                    <span className="metric-key">SPEED</span>
                    <span id="telemetrySpeed" className="metric-val">{telemetry.speed || "0.0 MB/s"}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-key">ETA</span>
                    <span id="telemetryEta" className="metric-val">{telemetry.eta || "--:--"}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-key">DOWNLOADED</span>
                    <span id="telemetryBytes" className="metric-val">{formatBytes(telemetry.downloaded_bytes)}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-key">STAGE</span>
                    <span id="telemetryStage" className="metric-val">{telemetry.status ? telemetry.status.toUpperCase() : "PROCESSING"}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Section 7: Success Console Card */}
            {downloadResult && !isDownloading && (
              <div id="successCard" className="terminal-success-card">
                <div className="success-top-row">
                  <div className="success-flag">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span>PROCESS COMPLETED (STATUS: 200 OK)</span>
                  </div>
                  <span id="successFileInfo" className="success-file-meta mono-text">
                    SIZE: {formatBytes(downloadResult.file_size)} • CONTAINER: {downloadResult.format}
                  </span>
                </div>

                <div className="success-details-box mono-text">
                  <div className="detail-row">
                    <span className="detail-key">OUTPUT FILE:</span>
                    <span id="savedFileName" className="detail-val text-accent">{downloadResult.filename}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-key">DISK PATH:</span>
                    <span id="savedPathText" className="detail-val">
                      {isLocalEnvironment ? downloadResult.file_path : "Tersedia di Server Cloud (Siap disimpan ke perangkat)"}
                    </span>
                  </div>
                </div>

                <div className="success-action-row">
                  <button
                    type="button"
                    id="streamBrowserBtn"
                    onClick={handleStreamDownload}
                    className="btn-solid-accent"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <path d="M21 15v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>BROWSER DOWNLOAD (SIMPAN KE PERANGKAT)</span>
                  </button>

                  {isLocalEnvironment && (
                    <button
                      type="button"
                      id="openSavedFolderBtn"
                      onClick={() => handleOpenFolder(downloadResult.folder_path)}
                      className="btn-terminal-sm"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                        <path d="M3 6h6l2 2.5h10v10.5H3V6z" />
                        <line x1="3" y1="11" x2="21" y2="11" />
                      </svg>
                      <span>OPEN IN FILE EXPLORER</span>
                    </button>
                  )}
                </div>
              </div>
            )}

          </div>
        )}
      </main>

      {/* Backend Settings Modal */}
      {showSettingsModal && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "rgba(0,0,0,0.8)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "16px"
        }}>
          <div style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-active)",
            borderRadius: "var(--radius-sm)",
            width: "100%",
            maxWidth: "460px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            fontFamily: "var(--font-mono)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-subtle)", paddingBottom: "10px" }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--accent)" }}>&gt; SERVER &amp; API CONFIGURATION</span>
              <button
                onClick={() => setShowSettingsModal(false)}
                style={{ background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: "1rem", fontWeight: "bold" }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "0.72rem", color: "var(--text-muted)", fontWeight: 600 }}>URL BACKEND RAILWAY / CLOUD API:</label>
              <input
                type="url"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
                placeholder="https://yt-downloader-production.up.railway.app"
                style={{
                  background: "var(--bg-terminal)",
                  border: "1px solid var(--border-hairline)",
                  color: "var(--text-main)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8rem",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-xs)",
                  outline: "none"
                }}
              />
              <span style={{ fontSize: "0.68rem", color: "var(--text-dim)" }}>
                Kosongkan jika berjalan secara lokal di localhost:5000.
              </span>
            </div>

            <div style={{ background: "var(--bg-terminal)", padding: "10px 12px", borderRadius: "var(--radius-xs)", border: "1px solid var(--border-hairline)", fontSize: "0.72rem", display: "flex", flexDirection: "column", gap: "4px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-dim)" }}>TARGET API BASE:</span>
                <span style={{ color: "var(--accent)" }}>{apiBase}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "var(--text-dim)" }}>SERVER STATUS:</span>
                <span style={{ color: backendHealth.status === "online" ? "var(--status-green)" : "var(--status-red)" }}>
                  {backendHealth.message}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem("YT_BACKEND_URL", backendUrl.trim());
                  checkHealth();
                  setShowSettingsModal(false);
                }}
                className="btn-solid-accent"
                style={{ flex: 1, padding: "10px" }}
              >
                SIMPAN &amp; RECONNECT
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem("YT_BACKEND_URL");
                  setBackendUrl("");
                  setShowSettingsModal(false);
                }}
                className="btn-terminal-sm"
                style={{ padding: "10px 14px" }}
              >
                RESET
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer Terminal Info */}
      <footer className="sys-footer">
        <div className="footer-meta mono-text">
          <span>CORE: python 3.10+</span>
          <span>•</span>
          <span>ENGINE: yt-dlp (web_embedded)</span>
          <span>•</span>
          <span>MUXER: ffmpeg v63.1</span>
          <span>•</span>
          <span>FRAMEWORK: React 18 + Tailwind CDN</span>
        </div>
      </footer>

    </div>
  );
}

// Mount React Root
const rootElement = document.getElementById("root");
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<App />);
}
