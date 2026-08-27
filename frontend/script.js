// API Base URL Detection
const API_BASE = window.location.port === "5000" || window.location.hostname === "localhost" 
  ? "/api" 
  : "http://localhost:5000/api";

// Elements
const urlInput = document.getElementById("urlInput");
const pasteBtn = document.getElementById("pasteBtn");
const fetchBtn = document.getElementById("fetchBtn");
const openMainFolderBtn = document.getElementById("openMainFolderBtn");

const loadingState = document.getElementById("loadingState");
const errorState = document.getElementById("errorState");
const errorTitle = document.getElementById("errorTitle");
const errorMessage = document.getElementById("errorMessage");

const resultSection = document.getElementById("resultSection");
const videoThumb = document.getElementById("videoThumb");
const videoTitle = document.getElementById("videoTitle");
const videoAuthor = document.getElementById("videoAuthor");
const videoDuration = document.getElementById("videoDuration");
const audioTracksCount = document.getElementById("audioTracksCount");
const videoTracksCount = document.getElementById("videoTracksCount");

const videoSelect = document.getElementById("videoSelect");
const audioSelect = document.getElementById("audioSelect");
const targetFolderPreview = document.getElementById("targetFolderPreview");

const downloadBtn = document.getElementById("downloadBtn");
const downloadStatusBox = document.getElementById("downloadStatusBox");
const statusMessage = document.getElementById("statusMessage");
const telemetryPercent = document.getElementById("telemetryPercent");
const telemetrySpeed = document.getElementById("telemetrySpeed");
const telemetryEta = document.getElementById("telemetryEta");
const telemetryBytes = document.getElementById("telemetryBytes");
const telemetryStage = document.getElementById("telemetryStage");
const progressBar = document.getElementById("progressBar");

const step1 = document.getElementById("step1");
const step2 = document.getElementById("step2");
const step3 = document.getElementById("step3");
const step4 = document.getElementById("step4");

const successCard = document.getElementById("successCard");
const successFileInfo = document.getElementById("successFileInfo");
const savedFileName = document.getElementById("savedFileName");
const savedPathText = document.getElementById("savedPathText");
const openSavedFolderBtn = document.getElementById("openSavedFolderBtn");
const streamBrowserBtn = document.getElementById("streamBrowserBtn");

let currentVideoData = null;
let lastDownloadResult = null;
let activeEventSource = null;
let activePollInterval = null;

// Helpers
function formatDuration(seconds) {
  if (!seconds) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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

function showError(title, msg) {
  errorTitle.textContent = title ? title.toUpperCase() : "FAILED TO EXTRACT STREAMS";
  errorMessage.textContent = msg || "Verify network connection and URL format.";
  errorState.classList.remove("hidden");
}

function hideError() {
  errorState.classList.add("hidden");
}

function resetStates() {
  hideError();
  loadingState.classList.add("hidden");
  resultSection.classList.add("hidden");
  downloadStatusBox.classList.add("hidden");
  successCard.classList.add("hidden");
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  if (activePollInterval) {
    clearInterval(activePollInterval);
    activePollInterval = null;
  }
}

// Paste Button
pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      urlInput.focus();
    }
  } catch (err) {
    console.warn("Clipboard access denied:", err);
  }
});

// Open Main Folder in File Explorer
async function openFolder(path = "") {
  try {
    const res = await fetch(`${API_BASE}/open-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Gagal membuka File Explorer.");
    }
  } catch (err) {
    alert("Gagal menghubungi server untuk membuka File Explorer.");
  }
}

openMainFolderBtn.addEventListener("click", () => openFolder(""));

// Fetch Video Formats
async function analyzeVideo() {
  const url = urlInput.value.trim();
  if (!url) {
    showError("EMPTY_URL", "Input error: YouTube stream URL cannot be empty.");
    return;
  }

  resetStates();
  loadingState.classList.remove("hidden");
  fetchBtn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/formats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to extract video stream manifests from YouTube.");
    }

    currentVideoData = data;
    renderVideoResult(data);
  } catch (err) {
    showError("EXTRACTION_ERROR", err.message || "Failed to communicate with local yt-dlp backend at port 5000.");
  } finally {
    loadingState.classList.add("hidden");
    fetchBtn.disabled = false;
  }
}

// Render Results
function renderVideoResult(data) {
  videoThumb.src = data.thumbnail || "";
  videoTitle.textContent = data.title || "Unknown YouTube Stream";
  videoAuthor.textContent = data.uploader ? data.uploader.toUpperCase() : "UNKNOWN_AUTHOR";
  videoDuration.textContent = formatDuration(data.duration);

  const safeName = sanitizeForPreview(data.title);
  targetFolderPreview.textContent = `H:\\YT-Downloader\\hasil\\${safeName}\\${safeName}.mp4`;

  audioTracksCount.textContent = `${data.audio_tracks.length} TRACKS`;
  videoTracksCount.textContent = `${data.video_tracks.length} FORMATS`;

  // Video dropdown
  videoSelect.innerHTML = "";
  if (data.video_tracks.length > 0) {
    data.video_tracks.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.format_id;
      const sizeStr = v.filesize ? ` • ~${formatBytes(v.filesize)}` : "";
      const fpsStr = v.fps && v.fps > 30 ? ` [${v.fps}fps]` : "";
      const codecStr = v.vcodec ? ` (${v.vcodec.split('.')[0]})` : "";
      opt.textContent = `[${v.resolution}] ${v.ext.toUpperCase()}${codecStr}${fpsStr}${sizeStr}`;
      videoSelect.appendChild(opt);
    });
  } else {
    const opt = document.createElement("option");
    opt.value = "bestvideo";
    opt.textContent = "[AUTO] Best Available Video Stream (DASH MP4)";
    videoSelect.appendChild(opt);
  }

  // Audio dropdown
  audioSelect.innerHTML = "";
  if (data.audio_tracks.length > 0) {
    data.audio_tracks.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.format_id;
      const langCode = (a.language || "UND").toUpperCase();
      const langName = (a.language_name || a.language || "AUDIO").toUpperCase();
      const bitrateStr = a.abr ? ` • ${a.abr}kbps` : "";
      const codecStr = a.acodec ? ` (${a.acodec.split('.')[0]})` : "";
      opt.textContent = `[${langCode}] ${langName}${codecStr}${bitrateStr}`;
      audioSelect.appendChild(opt);
    });
  } else {
    const opt = document.createElement("option");
    opt.value = "bestaudio";
    opt.textContent = "[DEFAULT] Master Stereo Audio Track";
    audioSelect.appendChild(opt);
  }

  resultSection.classList.remove("hidden");
}

// Update UI Telemetry & Pipeline Step in Real-Time
function updateTelemetryUI(jobData) {
  const percent = jobData.percent !== undefined ? jobData.percent : 0;
  const speed = jobData.speed || "0.0 MB/s";
  const eta = jobData.eta || "--:--";
  const phase = jobData.phase || "PROCESSING...";
  const status = jobData.status || "downloading";

  // Update Percentage badge
  telemetryPercent.textContent = `${percent.toFixed(1)}%`;
  progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;

  // Update Live Metrics Grid
  telemetrySpeed.textContent = speed;
  telemetryEta.textContent = eta;
  telemetryStage.textContent = status.toUpperCase();
  statusMessage.textContent = phase;

  if (jobData.total_bytes && jobData.total_bytes > 0) {
    const dlStr = formatBytes(jobData.downloaded_bytes || 0);
    const totStr = formatBytes(jobData.total_bytes || 0);
    telemetryBytes.textContent = `${dlStr} / ${totStr}`;
  } else {
    telemetryBytes.textContent = "CALCULATING...";
  }

  // Update pipeline step highlights
  [step1, step2, step3, step4].forEach(s => s.className = "pipeline-step");

  if (status === "extracting") {
    step1.classList.add("step-active");
  } else if (status === "downloading") {
    step1.classList.add("step-done");
    step2.classList.add("step-active");
  } else if (status === "muxing" || status === "finalizing") {
    step1.classList.add("step-done");
    step2.classList.add("step-done");
    step3.classList.add("step-active");
  } else if (status === "finished") {
    step1.classList.add("step-done");
    step2.classList.add("step-done");
    step3.classList.add("step-done");
    step4.classList.add("step-done");
  }
}

// Handle Real-Time Download
async function downloadVideo() {
  if (!currentVideoData) return;

  const url = urlInput.value.trim();
  const video_format_id = videoSelect.value;
  const audio_format_id = audioSelect.value;

  downloadBtn.disabled = true;
  successCard.classList.add("hidden");
  downloadStatusBox.classList.remove("hidden");

  // Initial state
  updateTelemetryUI({
    status: "extracting",
    percent: 5.0,
    speed: "0.0 MB/s",
    eta: "--:--",
    phase: "INITIATING TASK & EXTRACTING MANIFESTS...",
  });

  try {
    // 1. Kirim request untuk memulai background task
    const startRes = await fetch(`${API_BASE}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        video_format_id,
        audio_format_id,
      }),
    });

    const startData = await startRes.json();
    if (!startRes.ok || !startData.job_id) {
      throw new Error(startData.error || "Gagal memulai tugas unduhan.");
    }

    const jobId = startData.job_id;

    // 2. Dengarkan Real-Time Progress lewat Server-Sent Events (SSE)
    if (!!window.EventSource) {
      activeEventSource = new EventSource(`${API_BASE}/progress-stream/${jobId}`);

      activeEventSource.onmessage = (event) => {
        try {
          const job = JSON.parse(event.data);
          updateTelemetryUI(job);

          if (job.status === "finished") {
            activeEventSource.close();
            activeEventSource = null;
            onDownloadComplete(job.result);
          } else if (job.status === "error") {
            activeEventSource.close();
            activeEventSource = null;
            throw new Error(job.error || "Proses unduhan gagal.");
          }
        } catch (e) {
          console.error("Error parsing progress SSE event:", e);
        }
      };

      activeEventSource.onerror = () => {
        // Fallback ke polling jika SSE terputus
        if (activeEventSource) {
          activeEventSource.close();
          activeEventSource = null;
        }
        startPollingFallback(jobId);
      };
    } else {
      startPollingFallback(jobId);
    }

  } catch (err) {
    statusMessage.textContent = `[ERROR]: ${err.message}`;
    telemetrySpeed.textContent = "ABORTED";
    downloadBtn.disabled = false;
  }
}

// Fallback Polling
function startPollingFallback(jobId) {
  if (activePollInterval) clearInterval(activePollInterval);

  activePollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/progress/${jobId}`);
      if (!res.ok) return;
      const job = await res.json();
      updateTelemetryUI(job);

      if (job.status === "finished") {
        clearInterval(activePollInterval);
        activePollInterval = null;
        onDownloadComplete(job.result);
      } else if (job.status === "error") {
        clearInterval(activePollInterval);
        activePollInterval = null;
        throw new Error(job.error || "Proses unduhan gagal.");
      }
    } catch (e) {
      console.warn("Polling error:", e);
    }
  }, 250);
}

// On Download Completed
function onDownloadComplete(resultData) {
  lastDownloadResult = resultData || {};
  downloadBtn.disabled = false;

  setTimeout(() => {
    downloadStatusBox.classList.add("hidden");
    savedFileName.textContent = lastDownloadResult.filename || "output.mp4";
    savedPathText.textContent = lastDownloadResult.file_path || "hasil/video.mp4";
    successFileInfo.textContent = `SIZE: ${formatBytes(lastDownloadResult.file_size)} • CONTAINER: ISO MP4`;
    successCard.classList.remove("hidden");
  }, 350);
}

// Action Event Listeners
openSavedFolderBtn.addEventListener("click", () => {
  if (lastDownloadResult && lastDownloadResult.folder_path) {
    openFolder(lastDownloadResult.folder_path);
  }
});

streamBrowserBtn.addEventListener("click", () => {
  if (lastDownloadResult && lastDownloadResult.file_path) {
    window.location.href = `${API_BASE}/stream-file?path=${encodeURIComponent(lastDownloadResult.file_path)}`;
  }
});

fetchBtn.addEventListener("click", analyzeVideo);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    analyzeVideo();
  }
});
downloadBtn.addEventListener("click", downloadVideo);
