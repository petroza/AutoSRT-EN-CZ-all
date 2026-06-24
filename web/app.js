/* PZ Titulkovač - frontend */
"use strict";
const $ = (s) => document.querySelector(s);
const API = "api.php";

async function api(action, opts = {}) {
  const r = await fetch(`${API}?action=${action}`, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
  return body;
}

// upload s hlášením průběhu (fetch to neumí, proto XMLHttpRequest)
function uploadWithProgress(fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}?action=upload`);
    xhr.upload.onprogress = (e) => { onProgress(e.lengthComputable ? e.loaded : -1, e.total || 0); };
    xhr.onload = () => {
      let body; try { body = JSON.parse(xhr.responseText); } catch (_) { body = xhr.responseText; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error((body && body.error) || ("server vrátil HTTP " + xhr.status + " – soubor možná překračuje limit hostingu")));
    };
    xhr.onerror = () => reject(new Error("spojení se serverem selhalo (síť nebo velikost souboru)"));
    xhr.ontimeout = () => reject(new Error("vypršel čas nahrávání"));
    xhr.send(fd);
  });
}

const STATUS_TXT = { pending: "Ve frontě", processing: "Zpracovává worker…", done: "Hotovo", error: "Chyba" };
let selectedFile = null, currentId = null, pollTimer = null;

/* ---- login ---- */
async function boot() {
  const s = await api("status");
  if (s.logged_in) showApp(s); else showLogin();
}
function showLogin() {
  $("#loginView").classList.remove("hidden");
  $("#appView").classList.add("hidden");
}
function showApp(s) {
  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  window.ROLE = s.role || "";
  $("#whoami").textContent = (s.user || "") + (s.role === "admin" ? " (admin)" : "");
  loadJobs();
  clearInterval(pollTimer);
  pollTimer = setInterval(loadJobs, 3000);
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginErr").textContent = "";
  const fd = new FormData();
  fd.append("user", $("#liUser").value);
  fd.append("pass", $("#liPass").value);
  try { await api("login", { method: "POST", body: fd }); boot(); }
  catch (err) { $("#loginErr").textContent = err.message; }
});
$("#btnLogout").addEventListener("click", async () => { await api("logout", { method: "POST" }); showLogin(); });

/* ---- upload ---- */
function pickFile(f) {
  if (!f) return;
  selectedFile = f;
  $("#fileInfo").classList.remove("hidden");
  $("#fileInfo").innerHTML = `<b>${esc(f.name)}</b> · ${(f.size / 1048576).toFixed(1)} MB`;
  $("#btnUpload").disabled = false;
}
function setupDz() {
  const dz = $("#dropzone"), inp = $("#fileInput");
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => pickFile(inp.files[0]));
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => { if (e.dataTransfer.files.length) pickFile(e.dataTransfer.files[0]); });
}
function fmts() { return Array.from(document.querySelectorAll("#formats input:checked")).map(c => c.value); }
$("#btnUpload").addEventListener("click", async () => {
  if (!selectedFile) return;
  const f = fmts(); if (!f.length) { alert("Vyber aspoň jeden výstup."); return; }
  $("#btnUpload").disabled = true;
  const prog = $("#upProg"), bar = $("#upBar");
  prog.classList.remove("hidden", "indet"); bar.style.width = "0%";
  const totalMB = (selectedFile.size / 1048576).toFixed(1);
  setMsg("uploadMsg", "Nahrávám…", "");
  const fd = new FormData();
  fd.append("file", selectedFile);
  fd.append("language", $("#language").value);
  fd.append("formats", f.join(","));
  fd.append("llm", $("#useLlm").checked ? "1" : "0");
  try {
    const r = await uploadWithProgress(fd, (loaded, total) => {
      if (loaded < 0) {                       // průběh neznámý -> neurčitý pruh
        prog.classList.add("indet");
        setMsg("uploadMsg", "Nahrávám… (" + totalMB + " MB)", "");
        return;
      }
      const pct = total ? Math.round(loaded / total * 100) : 0;
      bar.style.width = pct + "%";
      if (pct >= 100) setMsg("uploadMsg", "Nahráno, ukládám na serveru…", "");
      else setMsg("uploadMsg", `Nahrávám… ${pct}% (${(loaded / 1048576).toFixed(1)} / ${totalMB} MB)`, "");
    });
    bar.style.width = "100%";
    setMsg("uploadMsg", "✓ Odesláno do fronty. Až poběží worker, přepíše se.", "ok");
    selectedFile = null; $("#fileInput").value = ""; $("#fileInfo").classList.add("hidden");
    currentId = r.job.id;
    setTimeout(() => prog.classList.add("hidden"), 900);
    loadJobs();
  } catch (e) {
    prog.classList.add("hidden");
    setMsg("uploadMsg", "Chyba: " + e.message, "err");
  } finally {
    $("#btnUpload").disabled = false;
  }
});

/* ---- jobs ---- */
async function loadJobs() {
  let data; try { data = await api("list"); } catch (e) { if (("" + e).includes("401")) showLogin(); return; }
  const ul = $("#jobs"); ul.innerHTML = "";
  if (!data.jobs.length) { ul.innerHTML = '<li class="job-meta" style="padding:6px">Zatím žádné zakázky.</li>'; return; }
  let anyActive = false;
  for (const j of data.jobs) {
    if (j.status === "pending" || j.status === "processing") anyActive = true;
    const li = document.createElement("li");
    li.className = "job" + (j.id === currentId ? " active" : "");
    const showBar = (j.status === "processing" || j.status === "pending");
    li.innerHTML = `
      <div class="job-name">${esc(j.filename)}</div>
      <div class="job-meta">${window.ROLE === "admin" && j.owner ? "👤" + esc(j.owner) + " · " : ""}${esc(j.language)} · ${esc((j.created_at || "").slice(5, 16))}${j.duration ? " · " + j.duration.toFixed(1) + "s" : ""}</div>
      <div class="job-right">
        <span class="badge ${j.status}">${esc(STATUS_TXT[j.status] || j.status)}</span>
        <button class="job-del" title="Smazat">✕</button>
      </div>
      ${showBar ? `<div class="jbar"><i style="width:${j.progress || 0}%"></i></div>` : ""}`;
    li.addEventListener("click", e => { if (e.target.classList.contains("job-del")) return; openJob(j); });
    li.querySelector(".job-del").addEventListener("click", e => { e.stopPropagation(); delJob(j.id); });
    ul.appendChild(li);
  }
  // pokud je otevřená aktivní zakázka, osvěž její náhled při dokončení
  if (currentId) {
    const cur = data.jobs.find(x => x.id === currentId);
    if (cur && cur.status === "done" && $("#downloads").classList.contains("hidden")) openJob(cur);
  }
  $("#workerPill").classList.toggle("ok", true);
  $("#workerPill").textContent = anyActive ? "fronta aktivní" : "fronta prázdná";
}

function openJob(j) {
  currentId = j.id;
  window.curJob = j;
  document.querySelectorAll(".job").forEach(el => el.classList.remove("active"));
  const pv = $("#preview"), dl = $("#downloads"), ed = $("#btnEditor");
  const canEdit = j.status === "done" && j.outputs && j.outputs.json;
  ed.classList.toggle("hidden", !canEdit);
  if (j.status === "done") {
    pv.classList.remove("muted");
    pv.textContent = j.text_preview || "(prázdný výstup)";
    dl.innerHTML = "";
    (j.formats || []).forEach(fmt => {
      if (j.outputs && j.outputs[fmt]) {
        const a = document.createElement("a");
        a.className = "btn small"; a.textContent = fmt.toUpperCase();
        a.href = `${API}?action=download&id=${j.id}&fmt=${fmt}`;
        dl.appendChild(a);
      }
    });
    dl.classList.toggle("hidden", !dl.children.length);
  } else if (j.status === "error") {
    pv.classList.add("muted"); pv.textContent = "Chyba: " + (j.error || "neznámá");
    dl.classList.add("hidden");
  } else {
    pv.classList.add("muted"); pv.textContent = STATUS_TXT[j.status] + " (" + (j.progress || 0) + " %)";
    dl.classList.add("hidden");
  }
  loadJobs();
}

async function delJob(id) {
  if (!confirm("Smazat tuto zakázku a její soubory?")) return;
  const fd = new FormData(); fd.append("id", id);
  try { await api("delete", { method: "POST", body: fd });
    if (id === currentId) { currentId = null; $("#preview").textContent = "Vyber zakázku ze seznamu."; $("#preview").classList.add("muted"); $("#downloads").classList.add("hidden"); }
    loadJobs();
  } catch (e) { alert("Smazání selhalo: " + e.message); }
}

/* =====================  KOREKTOR (Word-style)  ===================== */
const LOW_CONF = 0.5;
let edState = null;   // {id, segs:[{start,end,tokens:[{w,conf,orig?,cur,ok?}], manual?}]}

function segText(seg) {
  if (seg.manual != null) return seg.manual;
  let t = seg.tokens.map(x => x.cur).join(" ");
  return t.replace(/\s+([,.;:!?…])/g, "$1").replace(/\s+/g, " ").trim();
}
function tokClass(t) {
  if (t.manualEdited) return "tok";
  if (t.orig != null && t.cur === t.w) return "tok changed";
  if (t.conf < LOW_CONF && !t.ok && (t.orig == null)) return "tok low";
  return "tok";
}

async function openEditor() {
  const j = window.curJob; if (!j) return;
  $("#edMsg").textContent = "Načítám…"; $("#edBody").innerHTML = "";
  $("#editor").classList.remove("hidden");
  try {
    const data = await api(`result&id=${j.id}`);
    const segs = (data.result && data.result.segments) || [];
    edState = {
      id: j.id,
      segs: segs.map(s => ({
        start: s.start || 0, end: s.end || 0, manual: (s.manual != null ? s.manual : null),
        tokens: (s.tokens && s.tokens.length)
          ? s.tokens.map(t => ({ w: t.w, conf: (t.conf == null ? 1 : t.conf), orig: (t.orig != null ? t.orig : null), cur: t.w }))
          : (s.text || "").split(/\s+/).filter(Boolean).map(w => ({ w, conf: 1, orig: null, cur: w })),
      })),
    };
    $("#edMsg").textContent = "";
    renderEditor();
  } catch (e) { $("#edMsg").textContent = "Chyba: " + e.message; }
}

function renderEditor() {
  const body = $("#edBody"); body.innerHTML = "";
  edState.segs.forEach((seg, si) => {
    const row = document.createElement("div"); row.className = "ed-seg";
    const tm = document.createElement("div"); tm.className = "ed-time";
    tm.textContent = fmtTime(seg.start) + "→" + fmtTime(seg.end);
    const tx = document.createElement("div"); tx.className = "ed-text";
    if (seg.manual != null) {
      tx.textContent = seg.manual;
    } else {
      seg.tokens.forEach((t, ti) => {
        const sp = document.createElement("span");
        sp.className = tokClass(t); sp.textContent = t.cur;
        sp.addEventListener("click", (e) => { e.stopPropagation(); openWordMenu(e, si, ti); });
        sp.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openWordMenu(e, si, ti); });
        tx.appendChild(sp);
        if (ti < seg.tokens.length - 1) tx.appendChild(document.createTextNode(" "));
      });
    }
    const pen = document.createElement("button"); pen.className = "ed-pen"; pen.title = "Upravit celý řádek"; pen.textContent = "✎";
    pen.addEventListener("click", () => editLine(si));
    row.appendChild(tm); row.appendChild(tx); row.appendChild(pen);
    body.appendChild(row);
  });
}

function openWordMenu(ev, si, ti) {
  closeWordMenu();
  const t = edState.segs[si].tokens[ti];
  const menu = $("#wordMenu"); menu.innerHTML = "";
  const add = (label, cls, fn) => { const b = document.createElement("button"); if (cls) b.className = cls; b.textContent = label; b.addEventListener("click", () => { fn(); closeWordMenu(); renderEditor(); }); menu.appendChild(b); };
  const sep = () => { const d = document.createElement("div"); d.className = "wm-sep"; menu.appendChild(d); };

  if (t.orig != null) {
    if (t.cur !== t.w) add("✓ " + t.w + "  (oprava)", "wm-sugg", () => { t.cur = t.w; });
    if (t.cur !== t.orig) add("↶ " + t.orig + "  (původní)", "wm-orig", () => { t.cur = t.orig; });
  } else if (t.conf < LOW_CONF && !t.ok) {
    add("✓ Ponechat (je to dobře)", "wm-sugg", () => { t.ok = true; });
  }
  sep();
  add("✎ Přepsat ručně…", "", () => {
    const v = prompt("Oprav slovo:", t.cur);
    if (v != null && v.trim() !== "") { t.cur = v.trim(); t.manualEdited = true; }
  });
  menu.classList.remove("hidden");
  const x = Math.min(ev.clientX, window.innerWidth - 200);
  const y = Math.min(ev.clientY + 6, window.innerHeight - 140);
  menu.style.left = x + "px"; menu.style.top = y + "px";
}
function closeWordMenu() { $("#wordMenu").classList.add("hidden"); }

function editLine(si) {
  const seg = edState.segs[si];
  const v = prompt("Uprav celý řádek titulku:", segText(seg));
  if (v != null) { seg.manual = v.trim(); renderEditor(); }
}

function fmtTime(s) {
  s = Math.max(0, s || 0); const m = Math.floor(s / 60), sec = (s % 60);
  return m + ":" + sec.toFixed(1).padStart(4, "0");
}

async function saveEdits() {
  if (!edState) return;
  $("#edMsg").textContent = "Ukládám a přegenerovávám titulky…";
  const segments = edState.segs.map(s => ({ start: s.start, end: s.end, text: segText(s) }));
  try {
    await fetch(`${API}?action=save_edits`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: edState.id, segments }),
    }).then(async r => { if (!r.ok) throw new Error((await r.json()).error || ("HTTP " + r.status)); });
    $("#edMsg").textContent = "✓ Uloženo. Titulky přegenerovány.";
    // obnov náhled + odkazy (cache-bust)
    try {
      const j = await api(`job&id=${edState.id}`);
      window.curJob = j; openJob(j);
      $("#downloads").querySelectorAll("a").forEach(a => { a.href += "&t=" + Date.now(); });
    } catch (e) { /* ignore */ }
  } catch (e) { $("#edMsg").textContent = "Chyba uložení: " + e.message; }
}

$("#btnEditor").addEventListener("click", openEditor);
$("#edClose").addEventListener("click", () => { $("#editor").classList.add("hidden"); closeWordMenu(); });
$("#edFixAll").addEventListener("click", () => { edState.segs.forEach(s => s.tokens.forEach(t => { if (t.orig != null) t.cur = t.w; })); renderEditor(); });
$("#edRevertAll").addEventListener("click", () => { edState.segs.forEach(s => s.tokens.forEach(t => { if (t.orig != null) t.cur = t.orig; })); renderEditor(); });
$("#edSave").addEventListener("click", saveEdits);
document.addEventListener("click", closeWordMenu);

/* ---- util ---- */
function setMsg(id, txt, cls) { const el = $("#" + id); el.textContent = txt; el.className = "status-line" + (cls ? " " + cls : ""); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("#btnRefresh").addEventListener("click", loadJobs);
setupDz();
boot();
