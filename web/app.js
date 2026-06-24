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
let selectedFile = null, currentId = null, pollTimer = null, burninPollTimer = null;

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
  const pv = $("#preview"), dl = $("#downloads"), ed = $("#btnEditor"), ae = $("#btnAE");
  const canEdit = j.status === "done" && j.outputs && j.outputs.json;
  ed.classList.toggle("hidden", !canEdit);
  ae.classList.toggle("hidden", !canEdit);
  const canBurnin = j.status === "done" && j.outputs && j.outputs.srt;
  $("#btnBurnin").classList.toggle("hidden", !canBurnin);
  clearTimeout(burninPollTimer);
  if (canBurnin) {
    api("burnin_status&id=" + j.id).then(function(d) {
      updateBurninUI(d.burnin);
      if (d.burnin && (d.burnin.status === "pending" || d.burnin.status === "processing" || d.burnin.status === "burning")) pollBurnin();
    }).catch(function() {});
  } else {
    $("#burninSection").classList.add("hidden");
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
    const data = await api(`result&id=${window.curJob.id}`);
    const segs = (data.result && data.result.segments) || [];
    if (!segs.length) throw new Error("žádné segmenty");
    const subs = aeBuildSubs(segs, chars, lines);
    const base = (window.curJob.filename || "titulky").replace(/\.[^.]+$/, "");
    downloadBlob(aeBuildJsx(subs, size, compW, compH, fps, posY), base + "_AE.jsx", "application/javascript");
    $("#aeMsg").textContent = "✓ Staženo: " + subs.length + " titulků (" + lines + " řádk., " + chars + " zn., " + size + " px).";
    renderAePreview(subs);
  } catch (e) { $("#aeMsg").textContent = "Chyba: " + e.message; }
}
$("#btnAE").addEventListener("click", () => {
  $("#aeMsg").textContent = ""; $("#aePreview").classList.add("hidden");
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
  setMsg("burninMsg", "Odesílám požadavek na zapékání…", "");
  $("#burninDownload").classList.add("hidden");
  const fd = new FormData(); fd.append("id", j.id);
  try {
    await api("request_burnin", { method: "POST", body: fd });
    pollBurnin();
  } catch (e) { setMsg("burninMsg", "Chyba: " + e.message, "err"); }
}
async function pollBurnin() {
  const j = window.curJob; if (!j) return;
  clearTimeout(burninPollTimer);
  try {
    const data = await api("burnin_status&id=" + j.id);
    updateBurninUI(data.burnin);
    if (data.burnin && (data.burnin.status === "pending" || data.burnin.status === "processing" || data.burnin.status === "burning")) {
      burninPollTimer = setTimeout(pollBurnin, 3000);
    }
  } catch (e) { /* tiché selhání při pollingu */ }
}
function updateBurninUI(bi) {
  const sec = $("#burninSection"), dl = $("#burninDownload");
  if (!bi) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  dl.classList.add("hidden");
  if (bi.status === "done") {
    setMsg("burninMsg", "✓ Video se zapečenými titulky je připraveno.", "ok");
    dl.href = API + "?action=download_burnin&id=" + (window.curJob && window.curJob.id);
    dl.classList.remove("hidden");
  } else if (bi.status === "error") {
    setMsg("burninMsg", "Chyba zapékání: " + (bi.error || "neznámá"), "err");
  } else if (bi.status === "outdated") {
    setMsg("burninMsg", "Video zastaralé – titulky byly upraveny. Klikni znovu na 🎞 Zapéct.", "");
  } else {
    const STXT = { pending: "Ve frontě na zapékání…", burning: "Zapékám titulky…", processing: "Zpracovávám…" };
    $("#burninMsg").textContent = (STXT[bi.status] || bi.status) + " (" + (bi.progress || 0) + " %)";
    $("#burninMsg").className = "status-line";
  }
}
$("#btnBurnin").addEventListener("click", requestBurnin);

/* ---- util ---- */
function setMsg(id, txt, cls) { const el = $("#" + id); el.textContent = txt; el.className = "status-line" + (cls ? " " + cls : ""); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("#btnRefresh").addEventListener("click", loadJobs);
setupDz();
boot();
