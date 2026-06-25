<?php
require_once __DIR__ . '/lib.php';
ensure_dirs();
// HTML necacheovat – ať mobil/desktop vždy načte aktuální app.js/style.css
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
?><!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <title>PZ Titulkovač</title>
  <link rel="stylesheet" href="style.css?v=13">
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
              <option value="ru-RU">Ruština · ru-RU</option>
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
            <button id="btnRefresh" class="btn small ghost" title="Obnovit" aria-label="Obnovit seznam zakázek">↻</button>
          </div>
          <ul id="jobs" class="jobs"></ul>
        </div>
        <div class="card">
          <div class="card-head"><h2>Náhled</h2>
            <div class="head-tools">
              <button id="btnEditor" class="btn small ghost hidden">✎ Korektor</button>
              <button id="btnAE" class="btn small ghost hidden">🎬 After Effects</button>
              <button id="btnBurnin" class="btn small ghost hidden">🎞 Zapéct video</button>
              <button id="btnTranslate" class="btn small ghost hidden">🌐 Přeložit</button>
              <div id="downloads" class="downloads hidden"></div>
            </div>
          </div>
          <div id="preview" class="preview muted">Vyber zakázku ze seznamu.</div>
          <div id="burninSection" class="burnin-section hidden">
            <div class="burnin-info">
              <div id="burninMsg" class="status-line"></div>
              <div id="burninProg" class="upprog hidden"><i id="burninBar"></i></div>
            </div>
            <a id="burninDownload" class="btn small hidden" download>⬇ Stáhnout MP4</a>
          </div>
          <div id="translateSection" class="burnin-section hidden">
            <div class="burnin-info">
              <div id="translateMsg" class="status-line"></div>
              <div id="translateProg" class="upprog hidden"><i id="translateBar"></i></div>
              <div id="translateView" class="hidden" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
                <button id="tvOrig" class="btn small ghost" type="button">Originál</button>
                <button id="tvTrans" class="btn small" type="button">Překlad</button>
                <button id="tvEdit" class="btn small ghost" type="button">✎ Upravit po titulcích</button>
                <button id="tvSaveText" class="btn small primary hidden" type="button">💾 Uložit přepsaný text</button>
                <span id="tvHint" class="hidden" style="font-size:11px;color:var(--txt-mute);align-self:center">✎ klikni do textu nahoře a přepiš</span>
              </div>
            </div>
            <div id="translateDownloads" class="downloads hidden"></div>
          </div>
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
        <div class="ae-tabs" role="tablist">
          <button class="ae-tab active" data-tab="0" role="tab" aria-selected="true">Titulky</button>
          <button class="ae-tab" data-tab="1" role="tab" aria-selected="false">Kompozice</button>
        </div>

        <div class="ae-tab-panel" data-panel="0" role="tabpanel">
          <label class="ae-row"><span>Titulky</span>
            <select id="aeSubs"><option value="original">originál</option></select></label>
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
        </div>

        <div class="ae-tab-panel ae-tab-hidden" data-panel="1" role="tabpanel">
          <div class="ae-row"><span>Pozice titulků</span>
            <span class="ae-radios">
              <label><input type="radio" name="aePos" value="86" checked> dole</label>
              <label><input type="radio" name="aePos" value="10"> nahoře</label>
              <label><input type="radio" name="aePos" value="custom"> vlastní&nbsp;%</label>
            </span>
          </div>
          <div id="aePosCustomRow" class="ae-row hidden"><span></span>
            <span class="ae-inline-group">
              <input id="aePosCustom" type="number" value="86" min="1" max="99" style="width:70px">
              <span class="ae-unit">% výšky kompozice</span>
            </span>
          </div>
          <div class="ae-row"><span>Rozlišení kompozice</span>
            <select id="aeRes">
              <option value="1920x1080" selected>1080p FHD · 1920×1080</option>
              <option value="1280x720">720p HD · 1280×720</option>
              <option value="3840x2160">4K UHD · 3840×2160</option>
              <option value="4096x2160">4K DCI · 4096×2160</option>
              <option value="2560x1440">2K QHD · 2560×1440</option>
              <option value="1080x1920">9:16 Vertikální · 1080×1920</option>
              <option value="1080x1080">1:1 Čtverec · 1080×1080</option>
              <option value="custom">Vlastní rozlišení…</option>
            </select>
          </div>
          <div id="aeResCustomRow" class="ae-row hidden"><span></span>
            <span class="ae-inline-group">
              <input id="aeResW" type="number" value="1920" min="100" max="7680" style="width:72px">
              <span class="ae-unit">×</span>
              <input id="aeResH" type="number" value="1080" min="100" max="4320" style="width:72px">
              <span class="ae-unit">px</span>
            </span>
          </div>
          <div class="ae-row"><span>Snímků/s (FPS)</span>
            <select id="aeFps">
              <option value="23.976">23.976 (film/NTSC)</option>
              <option value="24">24 (kino)</option>
              <option value="25" selected>25 (PAL/CZ)</option>
              <option value="29.97">29.97 (NTSC)</option>
              <option value="30">30</option>
              <option value="50">50 (PAL HD)</option>
              <option value="59.94">59.94 (NTSC HD)</option>
              <option value="60">60</option>
            </select>
          </div>
        </div>

        <div id="aeMsg" class="status-line"></div>
        <div class="ae-actions">
          <button id="aeGen" class="btn small primary">Stáhnout .jsx</button>
          <button id="aeClose" class="btn small ghost">Zavřít</button>
        </div>
        <div id="aePreview" class="ae-preview hidden"></div>
        <div class="ae-hint">V After Effects: <b>File → Scripts → Run Script File…</b> a vyber stažený
          <b>.jsx</b>. Titulky se vloží jako časované textové vrstvy do aktivní kompozice
          (nebo se vytvoří nová v zadaném rozlišení a FPS). Dlouhé titulky se automaticky rozdělí.</div>
      </div>
    </div>
  </div>

    <!-- NASTAVENÍ ZAPÉKÁNÍ TITULKŮ DO VIDEA -->
    <div id="burninModal" class="ae-overlay hidden">
      <div class="ae-box">
        <div class="ae-title">🎞 Zapéct titulky do videa</div>
        <div id="biPreview" class="bi-preview"><div id="biPreviewText" class="bi-prev-text"></div></div>
        <div class="ae-hint" style="margin-top:-4px">Náhled velikosti a pozice (orientační).</div>
        <label class="ae-row"><span>Titulky</span>
          <select id="biSubs"><option value="original">originál</option></select></label>
        <label class="ae-row"><span>Režim</span>
          <select id="biMode">
            <option value="normal">normální</option>
            <option value="karaoke">karaoke (vybarvování slov)</option>
          </select></label>
        <label class="ae-row" id="biHiRow" style="display:none"><span>Barva zvýraznění</span>
          <select id="biHi">
            <option value="yellow">žlutá</option>
            <option value="green">zelená</option>
            <option value="cyan">azurová</option>
            <option value="red">červená</option>
          </select></label>
        <label class="ae-row"><span>Font</span>
          <select id="biFont">
            <option>Arial</option><option>Verdana</option><option>Tahoma</option>
            <option>Calibri</option><option>Segoe UI</option><option>Times New Roman</option>
            <option>Georgia</option><option>Impact</option><option>Courier New</option>
          </select></label>
        <label class="ae-row"><span>Velikost písma</span>
          <input id="biSize" type="number" value="24" min="8" max="80"></label>
        <div class="ae-row"><span>Pozice</span>
          <span class="ae-radios">
            <label><input type="radio" name="biPos" value="2" checked> dole</label>
            <label><input type="radio" name="biPos" value="5"> uprostřed</label>
            <label><input type="radio" name="biPos" value="8"> nahoře</label>
          </span></div>
        <label class="ae-row"><span>Výška od kraje (px)</span>
          <input id="biMargin" type="number" value="36" min="0" max="400"></label>
        <label class="ae-row"><span>Znaků na řádek</span>
          <input id="biChars" type="number" value="42" min="10" max="120"></label>
        <div class="ae-row"><span>Řádky</span>
          <span class="ae-radios">
            <label><input type="radio" name="biLines" value="1"> jednořádkové</label>
            <label><input type="radio" name="biLines" value="2" checked> dvouřádkové</label>
          </span></div>
        <label class="ae-row"><span>Tučně</span>
          <span class="ae-radios"><label><input type="checkbox" id="biBold"> tučné písmo</label></span></label>
        <label class="ae-row"><span>Podklad</span>
          <select id="biBg">
            <option value="none">žádný (jen okraj)</option>
            <option value="box">černý box (solid)</option>
          </select></label>
        <label class="ae-row"><span>Průhlednost podkladu (%)</span>
          <input id="biBgAlpha" type="number" value="35" min="0" max="100"></label>
        <label class="ae-row"><span>Okraj / box (px, 0 = auto)</span>
          <input id="biOutline" type="number" value="0" min="0" max="20"></label>
        <div id="biMsg" class="status-line"></div>
        <div class="ae-actions">
          <button id="biStart" class="btn small primary">Spustit zapékání</button>
          <button id="biClose" class="btn small ghost">Zavřít</button>
        </div>
        <div class="ae-hint">Worker vyrenderuje MP4 s vypálenými titulky (H.264). U dlouhých/4K videí
          to chvíli trvá — průběh uvidíš na liště. Font musí být nainstalovaný na PC s workerem.</div>
      </div>
    </div>

    <!-- PŘEKLAD TITULKŮ (po přepisu) -->
    <div id="translateModal" class="ae-overlay hidden">
      <div class="ae-box">
        <div class="ae-title">🌐 Přeložit titulky</div>
        <label class="ae-row"><span>Do jazyka</span>
          <select id="trTarget">
            <option value="en-US">Angličtina</option>
            <option value="cs-CZ">Čeština</option>
            <option value="uk-UA">Ukrajinština</option>
            <option value="ru-RU">Ruština</option>
            <option value="de-DE">Němčina</option>
            <option value="sk-SK">Slovenština</option>
            <option value="pl-PL">Polština</option>
            <option value="es-ES">Španělština</option>
            <option value="fr-FR">Francouzština</option>
            <option value="it-IT">Italština</option>
          </select></label>
        <div id="trMsg" class="status-line"></div>
        <div class="ae-actions">
          <button id="trStart" class="btn small primary">Přeložit</button>
          <button id="trClose" class="btn small ghost">Zavřít</button>
        </div>
        <div class="ae-hint">Překlad běží lokálně na workeru (LLM) a zachová časování titulků.
          U delších videí to chvíli trvá — průběh uvidíš na liště. Výsledek stáhneš jako SRT/VTT/TXT.</div>
      </div>
    </div>

    <!-- ÚPRAVA PŘEKLADU -->
    <div id="trEditModal" class="ae-overlay hidden">
      <div class="ae-box">
        <div class="ae-title">✎ Upravit překlad</div>
        <div id="trEditMsg" class="status-line"></div>
        <div id="trEditBody" style="max-height:50vh;overflow:auto;margin:8px 0"></div>
        <div class="ae-actions">
          <button id="trEditSave" class="btn small primary">Uložit změny</button>
          <button id="trEditClose" class="btn small ghost">Zavřít</button>
        </div>
        <div class="ae-hint">Uprav text jednotlivých titulků – časování zůstane. Po uložení se
          tvoje verze použije při zapékání i exportu do After Effects.</div>
      </div>
    </div>

  <script src="app.js?v=30"></script>
</body>
</html>
