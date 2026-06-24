<?php require_once __DIR__ . '/lib.php'; ensure_dirs(); ?><!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PZ Titulkovač</title>
  <link rel="stylesheet" href="style.css?v=4">
</head>
<body>
  <!-- PŘIHLÁŠENÍ -->
  <div id="loginView" class="login-wrap hidden">
    <form id="loginForm" class="login-card">
      <div class="brand"><span class="logo">◢◣</span><h1>PZ Titulkovač</h1></div>
      <p class="tagline">Online přepis řeči → časované titulky</p>
      <label class="field"><span>Jméno</span><input id="liUser" autocomplete="username" value="PetrZ"></label>
      <label class="field"><span>Heslo</span><input id="liPass" type="password" autocomplete="current-password"></label>
      <button class="btn primary" type="submit">Přihlásit</button>
      <div id="loginErr" class="login-err"></div>
    </form>
  </div>

  <!-- APLIKACE -->
  <div id="appView" class="hidden">
    <header class="topbar">
      <div class="brand"><span class="logo">◢◣</span>
        <div><h1>PZ Titulkovač</h1><p class="tagline">Online · časované SRT titulky</p></div>
      </div>
      <div class="top-right">
        <span id="workerPill" class="pill" title="Stav workeru">worker</span>
        <span id="whoami" class="who"></span>
        <button id="btnLogout" class="btn small ghost">Odhlásit</button>
      </div>
    </header>

    <main class="layout">
      <section class="col col-left">
        <div class="card">
          <h2><span class="step">1</span> Nahrát soubor</h2>
          <div id="dropzone" class="dropzone">
            <input type="file" id="fileInput" hidden
                   accept=".wav,.mp3,.mp4,.mov,.m4a,.mkv,.aac,.flac,.ogg,.opus,.webm,.avi">
            <div class="dz-inner">
              <div class="dz-icon">⤓</div>
              <p class="dz-title">Přetáhni soubor sem</p>
              <p class="dz-sub">WAV · MP3 · MP4 · MOV · M4A · MKV</p>
            </div>
          </div>
          <div id="fileInfo" class="file-info hidden"></div>
        </div>

        <div class="card">
          <h2><span class="step">2</span> Nastavení</h2>
          <label class="field"><span>Jazyk</span>
            <select id="language">
              <option value="auto">Auto (detekce)</option>
              <option value="cs-CZ" selected>Čeština · cs-CZ</option>
              <option value="en-US">Angličtina · en-US</option>
              <option value="uk-UA">Ukrajinština · uk-UA</option>
            </select>
          </label>
          <div class="field"><span>Výstupy</span>
            <div class="checks" id="formats">
              <label><input type="checkbox" value="srt" checked> SRT</label>
              <label><input type="checkbox" value="vtt" checked> VTT</label>
              <label><input type="checkbox" value="txt" checked> TXT</label>
              <label><input type="checkbox" value="json" checked> JSON</label>
            </div>
          </div>
          <label class="toggle"><input type="checkbox" id="useLlm" checked>
            <span>Automaticky opravit cizí slova a značky <b>(Ollama)</b></span></label>
          <button id="btnUpload" class="btn primary" disabled>Odeslat ke zpracování</button>
          <div id="upProg" class="upprog hidden"><i id="upBar"></i></div>
          <div id="uploadMsg" class="status-line"></div>
        </div>
      </section>

      <section class="col col-right">
        <div class="card grow">
          <div class="card-head"><h2>Zakázky / titulky</h2>
            <button id="btnRefresh" class="btn small ghost" title="Obnovit">↻</button>
          </div>
          <ul id="jobs" class="jobs"></ul>
        </div>
        <div class="card">
          <div class="card-head"><h2>Náhled</h2>
            <div class="head-tools">
              <button id="btnEditor" class="btn small ghost hidden">✎ Korektor</button>
              <button id="btnAE" class="btn small ghost hidden">🎬 After Effects</button>
              <div id="downloads" class="downloads hidden"></div>
            </div>
          </div>
          <div id="preview" class="preview muted">Vyber zakázku ze seznamu.</div>
        </div>
      </section>
    </main>
    <footer class="footer">PZ Titulkovač · web jen řídí frontu, přepis běží lokálně na workeru · audio jde jen mezi tvým webem a tvým PC</footer>

    <!-- KOREKTOR (Word-style) -->
    <div id="editor" class="editor-overlay hidden">
      <div class="editor-box">
        <div class="editor-head">
          <div class="editor-title">✎ Korektor titulků
            <span class="editor-hint">Podtržená slova klikni/ťukni → návrh, vlastní vrstvy, ruční úprava</span>
          </div>
          <div class="editor-actions">
            <button id="edFixAll" class="btn small">Opravit vše</button>
            <button id="edRevertAll" class="btn small ghost">Vrátit vše</button>
            <button id="edSave" class="btn small primary">Uložit &amp; přegenerovat</button>
            <button id="edClose" class="btn small ghost">Zavřít</button>
          </div>
        </div>
        <div id="edMsg" class="status-line"></div>
        <div id="edBody" class="editor-body"></div>
        <div class="editor-legend">
          <span class="lg lg-changed">opraveno</span>
          <span class="lg lg-low">nejisté</span>
          <span class="muted">· ťukni na slovo pro volby</span>
        </div>
      </div>
    </div>
    <div id="wordMenu" class="word-menu hidden"></div>

    <!-- EXPORT PRO AFTER EFFECTS -->
    <div id="aeModal" class="ae-overlay hidden">
      <div class="ae-box">
        <div class="ae-title">🎬 Export titulků pro After Effects</div>
        <label class="ae-row"><span>Velikost písma (px)</span>
          <input id="aeSize" type="number" value="80" min="8" max="400" step="2"></label>
        <label class="ae-row"><span>Znaků na řádek</span>
          <input id="aeChars" type="number" value="40" min="10" max="120"></label>
        <div class="ae-row"><span>Řádky</span>
          <span class="ae-radios">
            <label><input type="radio" name="aeLines" value="1"> jednořádkové</label>
            <label><input type="radio" name="aeLines" value="2" checked> dvouřádkové</label>
          </span>
        </div>
        <div id="aeMsg" class="status-line"></div>
        <div class="ae-actions">
          <button id="aeGen" class="btn small primary">Stáhnout .jsx</button>
          <button id="aeClose" class="btn small ghost">Zavřít</button>
        </div>
        <div class="ae-hint">V After Effects: <b>File → Scripts → Run Script File…</b> a vyber stažený
          <b>.jsx</b>. Titulky se vloží jako časované textové vrstvy do aktivní kompozice
          (nebo se vytvoří nová 1920×1080). Dlouhé titulky se automaticky rozdělí.</div>
      </div>
    </div>
  </div>

  <script src="app.js?v=4"></script>
</body>
</html>
