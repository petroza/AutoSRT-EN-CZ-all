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

const STATUS_TXT = { uploading: "Nahrávám…", pending: "Ve frontě", processing: "Zpracovává worker…", done: "Hotovo", error: "Chyba" };
let selectedFile = null, currentId = null, pollTimer = null, burninPollTimer = null, translatePollTimer = null, openToken = 0;

/* ---- login ---- */
async function boot() {
  try {
    const s = await api("status");
    if (s.logged_in) showApp(s); else showLogin();
  } catch (e) { showLogin(); }   // bez bílé obrazovky při výpadku
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
$("#btnLogout").addEventListener("click", async () => {
  try { await api("logout", { method: "POST" }); } catch (e) { /* i tak odhlásit */ }
  finally { clearInterval(pollTimer); clearTimeout(burninPollTimer); clearTimeout(translatePollTimer); showLogin(); }
});

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
  const total = selectedFile.size, totalMB = (total / 1048576).toFixed(1);
  setMsg("uploadMsg", "Připravuji nahrávání…", "");
  try {
    // 1) inicializace (jen metadata, žádná data) -> id zakázky
    const initFd = new FormData();
    initFd.append("filename", selectedFile.name);
    initFd.append("language", $("#language").value);
    initFd.append("formats", f.join(","));
    initFd.append("llm", $("#useLlm").checked ? "1" : "0");
    const init = await api("upload_init", { method: "POST", body: initFd });
    const id = init.id;

    // 2) soubor po malých kouscích (obchází 413 limit hostingu)
    const CHUNK = 4 * 1024 * 1024;   // 4 MB
    let sent = 0;
    for (let off = 0; off < total; off += CHUNK) {
      const blob = selectedFile.slice(off, Math.min(off + CHUNK, total));
      await sendChunk(id, blob);
      sent += blob.size;
      const pct = Math.round(sent / total * 100);
      bar.style.width = pct + "%";
      setMsg("uploadMsg", `Nahrávám… ${pct}% (${(sent / 1048576).toFixed(1)} / ${totalMB} MB)`, "");
    }

    // 3) dokončení -> zakázka přejde do fronty
    setMsg("uploadMsg", "Dokončuji na serveru…", "");
    const finFd = new FormData(); finFd.append("id", id);
    const fin = await api("upload_finish", { method: "POST", body: finFd });
    bar.style.width = "100%";
    setMsg("uploadMsg", "✓ Odesláno do fronty. Až poběží worker, přepíše se.", "ok");
    selectedFile = null; $("#fileInput").value = ""; $("#fileInfo").classList.add("hidden");
    currentId = fin.job.id;
    setTimeout(() => prog.classList.add("hidden"), 900);
    loadJobs();
  } catch (e) {
    prog.classList.add("hidden");
    setMsg("uploadMsg", "Chyba: " + e.message, "err");
  } finally {
    $("#btnUpload").disabled = false;
  }
});

// pošle jeden kousek s pár pokusy (mobilní síť občas zakolísá)
async function sendChunk(id, blob) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = new FormData();
      fd.append("id", id);
      fd.append("chunk", blob);
      return await api("upload_chunk", { method: "POST", body: fd });
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

/* ---- jobs ---- */
async function loadJobs() {
  let data; try { data = await api("list"); } catch (e) { if (("" + e).includes("401")) showLogin(); return; }
  const jobs = Array.isArray(data && data.jobs) ? data.jobs : [];
  const ul = $("#jobs"); ul.innerHTML = "";
  if (!jobs.length) { ul.innerHTML = '<li class="job-meta" style="padding:6px">Zatím žádné zakázky.</li>'; return; }
  let anyActive = false;
  for (const j of jobs) {
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
    const cur = jobs.find(x => x.id === currentId);
    if (cur && cur.status === "done" && $("#downloads").classList.contains("hidden")) openJob(cur);
  }
  $("#workerPill").classList.toggle("ok", true);
  $("#workerPill").textContent = anyActive ? "fronta aktivní" : "fronta prázdná";
}

function openJob(j) {
  currentId = j.id;
  const myToken = ++openToken;   // zahodit doběhlé async odpovědi staré zakázky
  window.curJob = j;
  window.curView = "orig";
  window.curViewExplicit = false;   // uživatel ještě ručně nevybral pohled
  $("#preview").contentEditable = "false"; $("#preview").style.outline = ""; $("#tvSaveText").classList.add("hidden"); $("#tvHint").classList.add("hidden");
  document.querySelectorAll(".job").forEach(el => el.classList.remove("active"));
  const pv = $("#preview"), dl = $("#downloads"), ed = $("#btnEditor"), ae = $("#btnAE");
  const canEdit = j.status === "done" && j.outputs && j.outputs.json;
  ed.classList.toggle("hidden", !canEdit);
  ae.classList.toggle("hidden", !canEdit);
  const canBurnin = j.status === "done" && j.outputs && j.outputs.srt;
  $("#btnBurnin").classList.toggle("hidden", !canBurnin);
  clearTimeout(burninPollTimer);
  if (canBurnin) {
    api("burnin_status&id=" + j.id).then(function(d) {
      if (myToken !== openToken) return;   // mezitím přepnuto na jinou zakázku
      updateBurninUI(d.burnin);
      if (d.burnin && (d.burnin.status === "pending" || d.burnin.status === "processing" || d.burnin.status === "burning")) pollBurnin();
    }).catch(function() {});
  } else {
    $("#burninSection").classList.add("hidden");
  }
  const canTranslate = j.status === "done" && j.outputs && j.outputs.json;
  $("#btnTranslate").classList.toggle("hidden", !canTranslate);
  clearTimeout(translatePollTimer);
  if (canTranslate) {
    api("translate_status&id=" + j.id).then(function(d) {
      if (myToken !== openToken) return;
      updateTranslateUI(d.translate);
      if (d.translate && (d.translate.status === "pending" || d.translate.status === "translating" || d.translate.status === "processing")) pollTranslate();
    }).catch(function() {});
  } else {
    window.curTranslate = null;
    $("#translateSection").classList.add("hidden");
  }
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
    if (id === currentId) {
      currentId = null; ++openToken; window.curJob = null; window.curTranslate = null;
      clearTimeout(burninPollTimer); clearTimeout(translatePollTimer);
      const pv = $("#preview");
      pv.textContent = "Vyber zakázku ze seznamu."; pv.classList.add("muted");
      pv.contentEditable = "false"; pv.style.outline = ""; pv.removeAttribute("title");
      ["#downloads", "#burninSection", "#translateSection", "#tvSaveText", "#tvHint",
       "#aeModal", "#burninModal", "#translateModal", "#trEditModal", "#editor"]
        .forEach(s => { const el = $(s); if (el) el.classList.add("hidden"); });
      ["btnEditor", "btnAE", "btnBurnin", "btnTranslate"].forEach(b => $("#" + b).classList.add("hidden"));
    }
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
  const x = Math.max(6, Math.min(ev.clientX, window.innerWidth - 200));
  const y = Math.max(6, Math.min(ev.clientY + 6, window.innerHeight - 140));
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

// Korektor opravuje to, co je zobrazené: originál -> klasický korektor,
// překlad -> editor přeložených titulků (jinak by ukazoval azbuku/originál).
function openCorrector() {
  if (window.curView === "trans" && window.curTranslate && window.curTranslate.status === "done") {
    openTransEditor();
  } else {
    openEditor();
  }
}
$("#btnEditor").addEventListener("click", openCorrector);
$("#edClose").addEventListener("click", () => { $("#editor").classList.add("hidden"); closeWordMenu(); });
$("#edFixAll").addEventListener("click", () => { if (!edState) return; edState.segs.forEach(s => s.tokens.forEach(t => { if (t.orig != null) t.cur = t.w; })); renderEditor(); });
$("#edRevertAll").addEventListener("click", () => { if (!edState) return; edState.segs.forEach(s => s.tokens.forEach(t => { if (t.orig != null) t.cur = t.orig; })); renderEditor(); });
$("#edSave").addEventListener("click", saveEdits);
document.addEventListener("click", closeWordMenu);
document.addEventListener("scroll", closeWordMenu, true);   // i vnitřní scroll (mobil)
document.addEventListener("touchmove", closeWordMenu, { passive: true });
window.addEventListener("resize", closeWordMenu);

/* =====================  EXPORT PRO AFTER EFFECTS  ===================== */
// Rozdělí text na titulky respektující 2D omezení (řádky × znaků).
// Vrací pole stringů se \r jako oddělovačem řádků (formát AE).
function aeChunkLines(text, perLine, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const result = []; let lines = [], cur = "";
  for (const w of words) {
    const candidate = cur ? cur + " " + w : w;
    if (candidate.length <= perLine) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) {
        result.push(lines.join("\r"));
        lines = [];
      }
    }
  }
  if (cur) lines.push(cur);
  if (lines.length) result.push(lines.join("\r"));
  return result.length ? result : [text];
}
// segmenty -> titulky pro AE; čas každého kusu se rozdělí poměrně dle délky
function aeBuildSubs(segments, perLine, maxLines) {
  const out = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim(); if (!text) continue;
    const start = seg.start || 0, end = seg.end || 0, dur = Math.max(0.2, end - start);
    const chunks = aeChunkLines(text, perLine, maxLines);
    const totalLen = chunks.reduce((s, c) => s + c.replace(/\r/g, " ").length, 0) || 1;
    let t = start;
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const chunkLen = chunk.replace(/\r/g, " ").length;
      const e2 = (ci === chunks.length - 1) ? end : Math.min(end, t + dur * (chunkLen / totalLen));
      out.push({ s: Math.round(t * 1000) / 1000, e: Math.round(e2 * 1000) / 1000, t: chunk });
      t = e2;
    }
  }
  return out;
}
// sestaví ExtendScript (.jsx) – ES3, žádné moderní konstrukce ve výstupu
function aeBuildJsx(subs, fontSize, compW, compH, fps, posYpct) {
  return "// AutoSRT → After Effects | vygenerovano z webu Titulkovac\n" +
    "// Spusteni: After Effects > File > Scripts > Run Script File... a vyber tento soubor.\n\n" +
    "(function () {\n" +
    "  var FONT_SIZE = " + fontSize + ";\n" +
    "  var COMP_W = " + compW + ", COMP_H = " + compH + ", COMP_FPS = " + fps + ";\n" +
    "  var POS_Y_PCT = " + posYpct + ";\n" +
    "  var SUBS = " + JSON.stringify(subs) + ";\n" +
    "  app.beginUndoGroup('AutoSRT titulky');\n" +
    "  var comp = app.project.activeItem;\n" +
    "  if (!(comp && comp instanceof CompItem)) {\n" +
    "    var maxE = 10; for (var k = 0; k < SUBS.length; k++) { if (SUBS[k].e > maxE) maxE = SUBS[k].e; }\n" +
    "    comp = app.project.items.addComp('AutoSRT titulky', COMP_W, COMP_H, 1.0, maxE + 1, COMP_FPS);\n" +
    "    comp.openInViewer();\n" +
    "  }\n" +
    "  for (var i = 0; i < SUBS.length; i++) {\n" +
    "    var sub = SUBS[i];\n" +
    "    var layer = comp.layers.addText(sub.t);\n" +
    "    var prop = layer.property('Source Text'); var doc = prop.value;\n" +
    "    doc.fontSize = FONT_SIZE; doc.applyFill = true; doc.fillColor = [1, 1, 1];\n" +
    "    doc.applyStroke = true; doc.strokeColor = [0, 0, 0]; doc.strokeWidth = Math.max(2, Math.round(FONT_SIZE / 18)); doc.strokeOverFill = false;\n" +
    "    doc.justification = ParagraphJustification.CENTER_JUSTIFY;\n" +
    "    prop.setValue(doc);\n" +
    "    layer.name = (i + 1) + ' ' + sub.t.replace(/\\r/g, ' ').substring(0, 28);\n" +
    "    layer.startTime = 0; layer.inPoint = sub.s; layer.outPoint = sub.e;\n" +
    "    try { layer.property('ADBE Transform Group').property('ADBE Position').setValue([comp.width / 2, comp.height * (POS_Y_PCT / 100)]); } catch (e) {}\n" +
    "  }\n" +
    "  app.endUndoGroup();\n" +
    "  alert('AutoSRT: vlozeno ' + SUBS.length + ' titulku.');\n" +
    "})();\n";
}
function downloadBlob(text, filename, mime) {
  const blob = new Blob(["﻿" + text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function aeTs(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
}
function renderAePreview(subs) {
  const el = $("#aePreview");
  if (!subs.length) { el.classList.add("hidden"); return; }
  let html = '<div class="ae-prev-head">' + subs.length + " titulků</div>" +
    '<table class="ae-prev-table">';
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    html += "<tr><td class=\"ae-prev-n\">" + (i + 1) + "</td>" +
      "<td class=\"ae-prev-t\">" + aeTs(s.s) + "–" + aeTs(s.e) + "</td>" +
      "<td class=\"ae-prev-txt\">" + esc(s.t).replace(/\r/g, "<br>") + "</td></tr>";
  }
  html += "</table>";
  el.innerHTML = html;
  el.classList.remove("hidden");
}
async function generateAE() {
  const size  = parseInt($("#aeSize").value, 10) || 80;
  const chars = parseInt($("#aeChars").value, 10) || 40;
  const lines = parseInt((document.querySelector("input[name=aeLines]:checked") || {}).value, 10) || 2;
  const posRadio = document.querySelector("input[name=aePos]:checked");
  const posY = posRadio && posRadio.value === "custom"
    ? (parseFloat($("#aePosCustom").value) || 86) : (parseFloat((posRadio || {}).value) || 86);
  const resVal = $("#aeRes").value;
  let compW = 1920, compH = 1080;
  if (resVal === "custom") {
    compW = parseInt($("#aeResW").value, 10) || 1920;
    compH = parseInt($("#aeResH").value, 10) || 1080;
  } else {
    const p = resVal.split("x");
    compW = parseInt(p[0], 10) || 1920; compH = parseInt(p[1], 10) || 1080;
  }
  const fps = parseFloat($("#aeFps").value) || 25;
  $("#aeMsg").textContent = "Generuji…";
  try {
    const subsSel = $("#aeSubs").value;
    let segs;
    if (subsSel && subsSel !== "original") {   // přeložené titulky -> parsuj SRT
      const r = await fetch(API + "?action=download_translate&id=" + window.curJob.id + "&fmt=srt&t=" + Date.now());
      if (!r.ok) throw new Error("překlad nelze načíst");
      segs = parseSrt(await r.text());
    } else {
      const data = await api(`result&id=${window.curJob.id}`);
      segs = (data.result && data.result.segments) || [];
    }
    if (!segs.length) throw new Error("žádné segmenty");
    const subs = aeBuildSubs(segs, chars, lines);
    const suff = (subsSel && subsSel !== "original") ? "_" + subsSel : "";
    const base = (window.curJob.filename || "titulky").replace(/\.[^.]+$/, "");
    downloadBlob(aeBuildJsx(subs, size, compW, compH, fps, posY), base + suff + "_AE.jsx", "application/javascript");
    $("#aeMsg").textContent = "✓ Staženo: " + subs.length + " titulků (" + lines + " řádk., " + chars + " zn., " + size + " px).";
    renderAePreview(subs);
  } catch (e) { $("#aeMsg").textContent = "Chyba: " + e.message; }
}
$("#btnAE").addEventListener("click", async () => {
  $("#aeMsg").textContent = ""; $("#aePreview").classList.add("hidden");
  fillSubsSelect($("#aeSubs"));
  refreshCurTranslate().then(function () {
    fillSubsSelect($("#aeSubs"));
    if (window.curTranslate && window.curTranslate.status === "done" && window.curTranslate.target)
      $("#aeSubs").value = window.curTranslate.target;   // předvyber překlad
  });
  if (window.curJob && window.curJob.fps) {
    const sel = $("#aeFps"), target = window.curJob.fps;
    let best = null, bestDiff = Infinity;
    for (let i = 0; i < sel.options.length; i++) {
      const d = Math.abs(parseFloat(sel.options[i].value) - target);
      if (d < bestDiff) { bestDiff = d; best = sel.options[i]; }
    }
    if (best && bestDiff < 2) best.selected = true;
  }
  $("#aeModal").classList.remove("hidden");
});
$("#aeClose").addEventListener("click", () => $("#aeModal").classList.add("hidden"));
$("#aeGen").addEventListener("click", generateAE);
document.querySelectorAll(".ae-tab").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".ae-tab").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected","false"); });
  document.querySelectorAll(".ae-tab-panel").forEach(p => p.classList.add("ae-tab-hidden"));
  btn.classList.add("active"); btn.setAttribute("aria-selected","true");
  document.querySelector(".ae-tab-panel[data-panel='" + btn.dataset.tab + "']").classList.remove("ae-tab-hidden");
}));
document.querySelectorAll("input[name=aePos]").forEach(r => r.addEventListener("change", () => {
  const custom = document.querySelector("input[name=aePos][value=custom]").checked;
  $("#aePosCustomRow").classList.toggle("hidden", !custom);
}));
$("#aeRes").addEventListener("change", () => {
  $("#aeResCustomRow").classList.toggle("hidden", $("#aeRes").value !== "custom");
});

/* =====================  ZAPÉKÁNÍ TITULKŮ  ===================== */
async function requestBurnin() {
  const j = window.curJob; if (!j) return;
  $("#burninModal").classList.add("hidden");
  setMsg("burninMsg", "Odesílám požadavek na zapékání…", "");
  $("#burninDownload").classList.add("hidden");
  const fd = new FormData();
  fd.append("id", j.id);
  fd.append("subs", $("#biSubs").value);
  fd.append("font", $("#biFont").value);
  fd.append("size", $("#biSize").value);
  fd.append("pos", (document.querySelector('input[name=biPos]:checked') || {}).value || "2");
  fd.append("margin", $("#biMargin").value);
  fd.append("chars", $("#biChars").value);
  fd.append("lines", (document.querySelector('input[name=biLines]:checked') || {}).value || "2");
  fd.append("bold", $("#biBold").checked ? "1" : "0");
  fd.append("bg", $("#biBg").value);
  fd.append("bgalpha", $("#biBgAlpha").value);
  fd.append("outline", $("#biOutline").value);
  fd.append("mode", $("#biMode").value);
  fd.append("hicolor", $("#biHi").value);
  try {
    await api("request_burnin", { method: "POST", body: fd });
    pollBurnin();
  } catch (e) { setMsg("burninMsg", "Chyba: " + e.message, "err"); }
}
async function pollBurnin() {
  const j = window.curJob; if (!j) return;
  const jobId = j.id;
  clearTimeout(burninPollTimer);
  try {
    const data = await api("burnin_status&id=" + jobId);
    if (!window.curJob || window.curJob.id !== jobId) return;   // mezitím přepnuto
    updateBurninUI(data.burnin);
    if (data.burnin && (data.burnin.status === "pending" || data.burnin.status === "processing" || data.burnin.status === "burning")) {
      burninPollTimer = setTimeout(pollBurnin, 3000);
    }
  } catch (e) { /* tiché selhání při pollingu */ }
}
function updateBurninUI(bi) {
  const sec = $("#burninSection"), dl = $("#burninDownload"), pr = $("#burninProg"), bar = $("#burninBar");
  if (!bi) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  dl.classList.add("hidden");
  if (bi.status === "done") {
    setMsg("burninMsg", "✓ Video se zapečenými titulky je připraveno.", "ok");
    pr.classList.add("hidden");
    dl.href = API + "?action=download_burnin&id=" + (window.curJob && window.curJob.id) + "&t=" + Date.now();
    dl.classList.remove("hidden");
  } else if (bi.status === "error") {
    setMsg("burninMsg", "Chyba zapékání: " + (bi.error || "neznámá"), "err");
    pr.classList.add("hidden");
  } else if (bi.status === "outdated") {
    setMsg("burninMsg", "Video zastaralé – titulky byly upraveny. Klikni znovu na 🎞 Zapéct.", "");
    pr.classList.add("hidden");
  } else {
    const STXT = { pending: "Ve frontě na zapékání…", burning: "Zapékám titulky…", processing: "Zpracovávám…" };
    setMsg("burninMsg", (STXT[bi.status] || bi.status) + " (" + (bi.progress || 0) + " %)", "");
    pr.classList.remove("hidden");
    bar.style.width = (bi.progress || 0) + "%";
  }
}
// čerstvě dotáhne stav překladu aktuální zakázky (kvůli časování při otevření dialogu)
async function refreshCurTranslate() {
  const j = window.curJob;
  if (!j) { window.curTranslate = null; return; }
  try {
    const d = await api("translate_status&id=" + j.id);
    window.curTranslate = d.translate || null;
  } catch (e) { /* ponech stávající stav */ }
}
// naplní výběr titulků (originál + dokončený překlad)
function fillSubsSelect(sel) {
  if (!sel) return;
  sel.innerHTML = '<option value="original">originál</option>';
  const tr = window.curTranslate;
  if (tr && tr.status === "done" && tr.target) {
    const o = document.createElement("option");
    o.value = tr.target; o.textContent = "překlad – " + tr.target;
    sel.appendChild(o);
  }
}
// parser SRT (pro AE z přeložených titulků)
function parseSrt(txt) {
  const segs = [];
  const blocks = (txt || "").replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n").filter(x => x.trim() !== "");
    const ti = lines.findIndex(l => l.indexOf("-->") >= 0);
    if (ti < 0) continue;
    const m = lines[ti].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const toSec = (h, mn, s, ms) => (+h) * 3600 + (+mn) * 60 + (+s) + (+ms) / 1000;
    segs.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]),
                text: lines.slice(ti + 1).join(" ").trim() });
  }
  return segs;
}
$("#btnBurnin").addEventListener("click", async function () {
  $("#biMsg").textContent = "";
  loadBurninSettings();                         // poslední použité nastavení
  fillSubsSelect($("#biSubs"));                 // hned z toho, co je známo
  // karaoke jen když je k dispozici JSON (časy slov)
  var hasJson = !!(window.curJob && window.curJob.outputs && window.curJob.outputs.json);
  var karOpt = document.querySelector('#biMode option[value=karaoke]');
  if (karOpt) karOpt.disabled = !hasJson;
  if (!hasJson && $("#biMode").value === "karaoke") $("#biMode").value = "normal";
  $("#biHiRow").style.display = ($("#biMode").value === "karaoke") ? "" : "none";
  $("#burninModal").classList.remove("hidden");
  setTimeout(updateBurninPreview, 0);           // až po vykreslení (kvůli šířce)
  await refreshCurTranslate();                  // a po dotažení znovu (kdyby překlad mezitím doběhl)
  fillSubsSelect($("#biSubs"));
  // když existuje překlad, předvyber ho (jinak by se omylem zapekl originál)
  if (window.curTranslate && window.curTranslate.status === "done" && window.curTranslate.target) {
    $("#biSubs").value = window.curTranslate.target;
  }
});
$("#biMode").addEventListener("change", function () {
  $("#biHiRow").style.display = (this.value === "karaoke") ? "" : "none";
});

/* ---- živý náhled velikosti/pozice titulků v dialogu zapékání ---- */
function biWrap(text, chars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (maxLines === 1) return [words.join(" ")];
  const lines = []; let cur = "";
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > chars) {
      lines.push(cur); cur = w;
      if (lines.length >= maxLines) { cur = ""; break; }   // dost řádků, zbytek zahodit
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}
function updateBurninPreview() {
  const box = $("#biPreview"), txt = $("#biPreviewText");
  if (!box || box.offsetParent === null) return;          // modal skrytý
  const vw = (window.curJob && window.curJob.width) || 1920;
  const vh = (window.curJob && window.curJob.height) || 1080;
  const pw = box.clientWidth;
  if (!pw) { requestAnimationFrame(updateBurninPreview); return; }   // okno ještě nemá šířku
  box.style.height = Math.round(pw * vh / vw) + "px";                // pevná výška dle poměru videa
  // kritické styly inline (nezávisle na CSS cache)
  box.style.position = "relative";
  box.style.overflow = "hidden";
  box.style.borderRadius = "8px";
  box.style.background = "linear-gradient(165deg,#41597a 0%,#5b6f63 55%,#3f4d34 100%)";
  txt.style.position = "absolute";
  txt.style.left = "0"; txt.style.right = "0";
  txt.style.padding = "0 5%"; txt.style.boxSizing = "border-box";
  txt.style.textAlign = "center";
  const scale = pw / vw;
  const size = parseInt($("#biSize").value, 10) || 24;
  const margin = parseInt($("#biMargin").value, 10) || 36;
  const chars = parseInt($("#biChars").value, 10) || 42;
  const lines = parseInt((document.querySelector('input[name=biLines]:checked') || {}).value, 10) || 2;
  const align = (document.querySelector('input[name=biPos]:checked') || {}).value || "2";
  const bold = $("#biBold").checked;
  const bg = $("#biBg").value, bgalpha = parseInt($("#biBgAlpha").value, 10) || 0;
  let outline = parseInt($("#biOutline").value, 10) || 0;
  if (outline <= 0) outline = Math.max(1, Math.round(size / 12));
  const font = $("#biFont").value, mode = $("#biMode").value, hi = $("#biHi").value;
  const HEX = { yellow: "#ffe000", green: "#39d353", cyan: "#19d3e6", red: "#ff5555" };

  // ukázka = JEN jedna titulková věta (ne celý přepis)
  const full = ((window.curJob && window.curJob.text_preview) || "Ukázkový titulek vašeho videa").replace(/\s+/g, " ").trim();
  let sample = (full.match(/^.*?[.!?](\s|$)/) || [full])[0].trim();
  const cap = Math.max(24, chars * lines);
  if (sample.length > cap) sample = sample.slice(0, cap).replace(/\s+\S*$/, "") + "…";
  const wl = biWrap(sample, chars, lines);
  let inner;
  if (mode === "karaoke") {
    const total = wl.join(" ").split(/\s+/).length, colorN = Math.ceil(total * 0.6);
    let idx = 0;
    inner = wl.map(function (ln) {
      return ln.split(/\s+/).map(function (w) {
        idx++; return idx <= colorN ? '<span style="color:' + (HEX[hi] || "#ffe000") + '">' + esc(w) + "</span>" : esc(w);
      }).join(" ");
    }).join("<br>");
  } else {
    inner = wl.map(esc).join("<br>");
  }
  const fontPx = Math.max(6, size * scale);
  let css = "font-family:'" + font + "',Arial,sans-serif;font-weight:" + (bold ? "700" : "400") +
            ";font-size:" + fontPx.toFixed(1) + "px;line-height:1.25;color:#fff;display:inline-block;max-width:100%;";
  if (bg === "box") {
    const pad = Math.max(1, outline * scale * 2);
    css += "background:rgba(0,0,0," + (1 - bgalpha / 100).toFixed(2) + ");padding:" + pad.toFixed(1) + "px " + (pad * 1.5).toFixed(1) + "px;";
  } else {
    const ow = Math.max(0.5, outline * scale);
    css += "text-shadow:" + [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]
      .map(function (d) { return (d[0] * ow).toFixed(1) + "px " + (d[1] * ow).toFixed(1) + "px 0 #000"; }).join(",") + ";";
  }
  txt.innerHTML = '<span style="' + css + '">' + inner + "</span>";
  const m = (margin * scale).toFixed(1) + "px";
  txt.style.top = txt.style.bottom = "auto"; txt.style.transform = "none";
  if (align === "8") txt.style.top = m;
  else if (align === "5") { txt.style.top = "50%"; txt.style.transform = "translateY(-50%)"; }
  else txt.style.bottom = m;
}
["input", "change"].forEach(function (ev) {
  $("#burninModal").addEventListener(ev, function () { updateBurninPreview(); saveBurninSettings(); });
});
$("#biClose").addEventListener("click", function () { $("#burninModal").classList.add("hidden"); });
$("#biStart").addEventListener("click", requestBurnin);

/* ---- zapamatování posledního nastavení titulků (localStorage) ---- */
var BI_VAL_KEYS = ["biFont", "biSize", "biMargin", "biChars", "biBg", "biBgAlpha", "biOutline", "biMode", "biHi"];
function saveBurninSettings() {
  try {
    const s = {};
    BI_VAL_KEYS.forEach(function (id) { const e = $("#" + id); if (e) s[id] = e.value; });
    s.biPos = (document.querySelector('input[name=biPos]:checked') || {}).value;
    s.biLines = (document.querySelector('input[name=biLines]:checked') || {}).value;
    s.biBold = $("#biBold").checked;
    localStorage.setItem("pzBurnin", JSON.stringify(s));
  } catch (e) { /* localStorage nedostupné */ }
}
function loadBurninSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem("pzBurnin") || "null"); } catch (e) { s = null; }
  if (!s) return;
  BI_VAL_KEYS.forEach(function (id) { const e = $("#" + id); if (e && s[id] != null) e.value = s[id]; });
  if (s.biPos) { const r = document.querySelector('input[name=biPos][value="' + s.biPos + '"]'); if (r) r.checked = true; }
  if (s.biLines) { const r2 = document.querySelector('input[name=biLines][value="' + s.biLines + '"]'); if (r2) r2.checked = true; }
  if (typeof s.biBold === "boolean") $("#biBold").checked = s.biBold;
}

/* =====================  PŘEKLAD TITULKŮ  ===================== */
async function requestTranslate() {
  const j = window.curJob; if (!j) return;
  $("#translateModal").classList.add("hidden");
  const st = window.curTranslate && window.curTranslate.status;
  if (st === "pending" || st === "translating" || st === "processing") {
    setMsg("translateMsg", "Překlad už probíhá – počkej na dokončení.", "err");
    return;   // zabraň závodu dvou překladů (smíchaný jazyk)
  }
  setMsg("translateMsg", "Odesílám požadavek na překlad…", "");
  $("#translateDownloads").classList.add("hidden");
  const fd = new FormData();
  fd.append("id", j.id);
  fd.append("target", $("#trTarget").value);
  try {
    await api("request_translate", { method: "POST", body: fd });
    pollTranslate();
  } catch (e) { setMsg("translateMsg", "Chyba: " + e.message, "err"); }
}
async function pollTranslate() {
  const j = window.curJob; if (!j) return;
  const jobId = j.id;
  clearTimeout(translatePollTimer);
  try {
    const data = await api("translate_status&id=" + jobId);
    if (!window.curJob || window.curJob.id !== jobId) return;   // mezitím přepnuto
    updateTranslateUI(data.translate);
    if (data.translate && (data.translate.status === "pending" || data.translate.status === "translating" || data.translate.status === "processing")) {
      translatePollTimer = setTimeout(pollTranslate, 3000);
    } else if (data.translate && data.translate.status === "done") {
      setPreviewView("trans");        // překlad doběhl -> rovnou ukázat přeložený text
    }
  } catch (e) { /* tiché selhání při pollingu */ }
}
// přepne text v náhledu mezi originálem a překladem
function setPreviewView(which) {
  const pv = $("#preview"), j = window.curJob, tr = window.curTranslate;
  if (!pv || !j) return;
  const hasTrans = tr && tr.status === "done" && tr.text;
  if (which === "trans" && hasTrans) {
    pv.classList.remove("muted"); pv.textContent = tr.text;
    pv.contentEditable = "true"; pv.style.outline = "1px dashed #2f9e74"; pv.title = "Klikni a přepiš text, pak ulož.";
    $("#tvSaveText").classList.remove("hidden");
    $("#tvHint").classList.remove("hidden");
    $("#tvTrans").classList.remove("ghost"); $("#tvOrig").classList.add("ghost");
    window.curView = "trans";
  } else {
    pv.classList.remove("muted"); pv.textContent = j.text_preview || "(prázdný výstup)";
    pv.contentEditable = "false"; pv.style.outline = ""; pv.removeAttribute("title");
    $("#tvSaveText").classList.add("hidden");
    $("#tvHint").classList.add("hidden");
    $("#tvOrig").classList.remove("ghost"); $("#tvTrans").classList.add("ghost");
    window.curView = "orig";
  }
}
async function saveTransText() {
  const j = window.curJob; if (!j) return;
  const text = ($("#preview").innerText || "").replace(/\s+/g, " ").trim();
  if (!text) { setMsg("translateMsg", "Prázdný text.", "err"); return; }
  setMsg("translateMsg", "Ukládám přepsaný text…", "");
  const fd = new FormData(); fd.append("id", j.id); fd.append("text", text);
  try {
    const res = await api("save_translate_text", { method: "POST", body: fd });
    if (window.curTranslate) window.curTranslate.text = res.text;
    setPreviewView("trans");
    setMsg("translateMsg", "✓ Text uložen – zapékání/AE použijí tvou verzi.", "ok");
  } catch (e) { setMsg("translateMsg", "Chyba uložení: " + e.message, "err"); }
}
function updateTranslateUI(tr) {
  window.curTranslate = tr || null;   // pro výběr titulků v zapékání / AE
  const sec = $("#translateSection"), dls = $("#translateDownloads"), pr = $("#translateProg"), bar = $("#translateBar");
  if (!tr) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  dls.classList.add("hidden"); dls.innerHTML = "";
  $("#translateView").classList.add("hidden");
  if (tr.status === "done") {
    setMsg("translateMsg", "✓ Překlad (" + (tr.target || "") + ") hotový.", "ok");
    pr.classList.add("hidden");
    const id = window.curJob && window.curJob.id;
    ["srt", "vtt", "txt"].forEach(function (fmt) {
      const a = document.createElement("a");
      a.className = "btn small"; a.download = "";
      a.href = API + "?action=download_translate&id=" + id + "&fmt=" + fmt + "&t=" + Date.now();
      a.textContent = "⬇ " + fmt.toUpperCase();
      dls.appendChild(a);
    });
    dls.classList.remove("hidden");
    if (tr.text) {                                   // přepínač náhledu originál/překlad
      $("#translateView").classList.remove("hidden");
      $("#tvTrans").textContent = "Překlad – " + (tr.target || "");
      // když existuje překlad, ukaž rovnou JEHO (dokud uživatel ručně nepřepne)
      setPreviewView(window.curViewExplicit ? window.curView : "trans");
    }
  } else if (tr.status === "error") {
    setMsg("translateMsg", "Chyba překladu: " + (tr.error || "neznámá"), "err");
    pr.classList.add("hidden");
  } else if (tr.status === "outdated") {
    setMsg("translateMsg", "Překlad zastaralý – titulky byly upraveny. Klikni znovu na 🌐 Přeložit.", "");
    pr.classList.add("hidden");
  } else {
    const STXT = { pending: "Ve frontě na překlad…", translating: "Překládám…", processing: "Zpracovávám…" };
    setMsg("translateMsg", (STXT[tr.status] || tr.status) + " (" + (tr.progress || 0) + " %)", "");
    pr.classList.remove("hidden");
    bar.style.width = (tr.progress || 0) + "%";
  }
}
$("#btnTranslate").addEventListener("click", function () { $("#trMsg").textContent = ""; $("#translateModal").classList.remove("hidden"); });
$("#trClose").addEventListener("click", function () { $("#translateModal").classList.add("hidden"); });
$("#trStart").addEventListener("click", requestTranslate);
$("#tvOrig").addEventListener("click", function () { window.curViewExplicit = true; setPreviewView("orig"); });
$("#tvTrans").addEventListener("click", function () { window.curViewExplicit = true; setPreviewView("trans"); });

/* ---- ruční úprava překladu (časování zůstane) ---- */
function fmtSec(s) { const m = Math.floor(s / 60), x = Math.floor(s % 60); return m + ":" + (x < 10 ? "0" : "") + x; }
async function openTransEditor() {
  const j = window.curJob, tr = window.curTranslate;
  if (!j || !tr || tr.status !== "done") return;
  $("#trEditMsg").textContent = "Načítám…"; $("#trEditBody").innerHTML = "";
  $("#trEditModal").classList.remove("hidden");
  try {
    const r = await fetch(API + "?action=download_translate&id=" + j.id + "&fmt=srt&t=" + Date.now());
    if (!r.ok) throw new Error("nelze načíst překlad");
    const segs = parseSrt(await r.text());
    const body = $("#trEditBody"); body.innerHTML = "";
    segs.forEach(function (s) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px";
      const lab = document.createElement("span");
      lab.style.cssText = "font-size:12px;color:#8a8f98;min-width:70px;font-variant-numeric:tabular-nums";
      lab.textContent = fmtSec(s.start) + "–" + fmtSec(s.end);
      const inp = document.createElement("input");
      inp.className = "tr-edit-line"; inp.type = "text"; inp.value = s.text;
      inp.style.cssText = "flex:1;min-width:0;background:#0a0c0f;border:1px solid #2a2e35;color:#fff;border-radius:4px;padding:5px 7px;font-size:14px";
      row.appendChild(lab); row.appendChild(inp); body.appendChild(row);
    });
    $("#trEditMsg").textContent = segs.length + " titulků – uprav text a ulož";
  } catch (e) { $("#trEditMsg").textContent = "Chyba: " + e.message; }
}
async function saveTransEdits() {
  const j = window.curJob; if (!j) return;
  const lines = [...document.querySelectorAll('#trEditBody .tr-edit-line')].map(function (i) { return i.value; });
  $("#trEditMsg").textContent = "Ukládám…";
  const fd = new FormData(); fd.append("id", j.id); fd.append("lines", JSON.stringify(lines));
  try {
    const res = await api("save_translate_edits", { method: "POST", body: fd });
    if (window.curTranslate) window.curTranslate.text = res.text;
    setPreviewView("trans");
    $("#trEditModal").classList.add("hidden");
    setMsg("translateMsg", "✓ Překlad upraven – zapékání/AE použijí tvou verzi.", "ok");
  } catch (e) { $("#trEditMsg").textContent = "Chyba uložení: " + e.message; }
}
$("#tvSaveText").addEventListener("click", saveTransText);
$("#tvEdit").addEventListener("click", openTransEditor);
$("#trEditSave").addEventListener("click", saveTransEdits);
$("#trEditClose").addEventListener("click", function () { $("#trEditModal").classList.add("hidden"); });

/* ---- util ---- */
function setMsg(id, txt, cls) { const el = $("#" + id); el.textContent = txt; el.className = "status-line" + (cls ? " " + cls : ""); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("#btnRefresh").addEventListener("click", loadJobs);
setupDz();
boot();
