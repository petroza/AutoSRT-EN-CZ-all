/* PZ ASR Studio - frontend logika */
"use strict";

const $ = (sel) => document.querySelector(sel);
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.detail) || body || ("HTTP " + r.status));
  return body;
});

const STATUS_TXT = {
  uploaded: "Nahráno",
  converting_audio: "Převádím audio…",
  ready_for_asr: "Připraveno k přepisu",
  transcribing: "Přepisuji…",
  exporting: "Exportuji výstupy…",
  done: "Hotovo",
  error: "Chyba",
};

let selectedFile = null;
let currentJobId = null;
let pollTimer = null;

/* ---------------- Diagnostika ---------------- */
async function loadStatus() {
  try {
    const s = await api("/api/status");
    setPill("python", s.python_ok, "Python " + (s.python || ""));
    setPill("ffmpeg", s.ffmpeg && s.ffmpeg.ok, s.ffmpeg && s.ffmpeg.ffmpeg);
    setPill("parakeet", s.parakeet && s.parakeet.ok, s.parakeet && s.parakeet.exe);
    setPill("model", s.model && s.model.ok, s.model && (s.model.name || s.model.path));
  } catch (e) {
    ["python", "ffmpeg", "parakeet", "model"].forEach((k) => setPill(k, false, "backend nedostupný"));
  }
}
function setPill(key, ok, title) {
  const el = document.querySelector(`.pill[data-k="${key}"]`);
  if (!el) return;
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("bad", !ok);
  el.title = title || "";
}

/* ---------------- Výběr souboru ---------------- */
function pickFile(file) {
  if (!file) return;
  selectedFile = file;
  const mb = (file.size / (1024 * 1024)).toFixed(1);
  const info = $("#fileInfo");
  info.classList.remove("hidden");
  info.innerHTML = `<b>${escapeHtml(file.name)}</b> · ${mb} MB · ${escapeHtml(file.type || "?")}`;
  $("#btnTranscribe").disabled = false;
}

function setupDropzone() {
  const dz = $("#dropzone");
  const input = $("#fileInput");
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => pickFile(input.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]);
  });
}

function selectedFormats() {
  return Array.from(document.querySelectorAll('#formats input:checked')).map((c) => c.value);
}

/* ---------------- Spuštění přepisu ---------------- */
async function startTranscription() {
  if (!selectedFile) return;
  const language = $("#language").value;
  const formats = selectedFormats();
  if (!formats.length) { alert("Vyber aspoň jeden výstupní formát."); return; }

  $("#btnTranscribe").disabled = true;
  setStatus("Nahrávám soubor…", "");
  setProgress(3);
  $("#log").textContent = "";
  $("#downloads").classList.add("hidden");
  $("#preview").classList.add("muted");
  $("#preview").textContent = "Zatím žádný přepis.";

  try {
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("language", language);
    fd.append("formats", formats.join(","));
    const up = await api("/api/upload", { method: "POST", body: fd });
    currentJobId = up.job_id;

    await api(`/api/transcribe/${currentJobId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, formats }),
    });
    pollJob(currentJobId);
    loadHistory();
  } catch (e) {
    setStatus("Chyba: " + e.message, "err");
    $("#btnTranscribe").disabled = false;
  }
}

/* ---------------- Polling jobu ---------------- */
function pollJob(jobId) {
  clearInterval(pollTimer);
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      renderJobProgress(job);
      const logTxt = await api(`/api/jobs/${jobId}/log`);
      const logEl = $("#log");
      logEl.textContent = logTxt || "";
      logEl.scrollTop = logEl.scrollHeight;

      if (job.status === "done") {
        clearInterval(pollTimer);
        showResult(job);
        $("#btnTranscribe").disabled = false;
        loadHistory();
      } else if (job.status === "error") {
        clearInterval(pollTimer);
        setStatus("Chyba: " + (job.error || "neznámá"), "err");
        $("#btnTranscribe").disabled = false;
        loadHistory();
      }
    } catch (e) {
      clearInterval(pollTimer);
      setStatus("Spojení ztraceno: " + e.message, "err");
      $("#btnTranscribe").disabled = false;
    }
  };
  tick();
  pollTimer = setInterval(tick, 1000);
}

function renderJobProgress(job) {
  setProgress(job.progress || 0);
  const txt = STATUS_TXT[job.status] || job.status;
  setStatus(txt, job.status === "done" ? "ok" : (job.status === "error" ? "err" : ""));
}

function showResult(job) {
  setProgress(100);
  setStatus("Hotovo · " + (job.duration ? job.duration.toFixed(1) + " s audia" : ""), "ok");
  const pv = $("#preview");
  pv.classList.remove("muted");
  pv.textContent = job.text_preview || "(prázdný výstup)";
  setupDownloads(job);
}

function setupDownloads(job) {
  const dl = $("#downloads");
  const map = { Txt: "txt", Srt: "srt", Vtt: "vtt", Json: "json" };
  let any = false;
  for (const [suffix, fmt] of Object.entries(map)) {
    const a = $("#dl" + suffix);
    const has = !!job["output_" + fmt];
    a.classList.toggle("hidden", !has);
    if (has) { a.href = `/api/download/${job.id}/${fmt}`; any = true; }
  }
  dl.classList.toggle("hidden", !any);
}

/* ---------------- Historie ---------------- */
async function loadHistory() {
  try {
    const { jobs } = await api("/api/jobs");
    const ul = $("#history");
    ul.innerHTML = "";
    if (!jobs.length) {
      ul.innerHTML = '<li class="hist-meta" style="padding:6px">Zatím žádné přepisy.</li>';
      return;
    }
    for (const job of jobs) {
      const li = document.createElement("li");
      li.className = "hist-item" + (job.id === currentJobId ? " active" : "");
      const badgeCls = job.status === "done" ? "done"
        : job.status === "error" ? "error" : "run";
      li.innerHTML = `
        <div class="hist-name">${escapeHtml(job.filename)}</div>
        <div class="hist-meta">${escapeHtml(job.language)} · ${escapeHtml(fmtDate(job.created_at))}</div>
        <span class="hist-badge ${badgeCls}">${escapeHtml(STATUS_TXT[job.status] || job.status)}</span>
        <button class="hist-del" title="Smazat">✕</button>`;
      li.addEventListener("click", (e) => {
        if (e.target.classList.contains("hist-del")) return;
        openJob(job);
      });
      li.querySelector(".hist-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteJob(job.id);
      });
      ul.appendChild(li);
    }
  } catch (e) { /* tiše */ }
}

async function openJob(job) {
  currentJobId = job.id;
  loadHistory();
  if (job.status === "done") {
    renderJobProgress(job);
    showResult(job);
  } else if (job.status === "error") {
    setProgress(job.progress || 0);
    setStatus("Chyba: " + (job.error || "neznámá"), "err");
    $("#downloads").classList.add("hidden");
    $("#preview").classList.add("muted");
    $("#preview").textContent = "(přepis selhal)";
  } else {
    pollJob(job.id);
  }
  try {
    $("#log").textContent = await api(`/api/jobs/${job.id}/log`);
  } catch (e) { /* ignore */ }
}

async function deleteJob(jobId) {
  if (!confirm("Opravdu smazat tento job a jeho soubory?")) return;
  try {
    await api(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (jobId === currentJobId) {
      currentJobId = null;
      $("#preview").classList.add("muted");
      $("#preview").textContent = "Zatím žádný přepis.";
      $("#downloads").classList.add("hidden");
    }
    loadHistory();
  } catch (e) { alert("Smazání selhalo: " + e.message); }
}

/* ---------------- Pomocné ---------------- */
function setProgress(p) { $("#progressBar").style.width = Math.max(0, Math.min(100, p)) + "%"; }
function setStatus(txt, cls) {
  const el = $("#statusLine");
  el.textContent = txt;
  el.className = "status-line" + (cls ? " " + cls : "");
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  if (!iso) return "";
  return iso.replace("T", " ").slice(0, 16);
}

/* ---------------- Init ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  setupDropzone();
  $("#btnTranscribe").addEventListener("click", startTranscription);
  $("#btnRefresh").addEventListener("click", loadHistory);
  loadStatus();
  loadHistory();
  setInterval(loadStatus, 15000);
});
