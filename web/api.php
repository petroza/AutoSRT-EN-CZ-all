<?php
// ============================================================
//  PZ Titulkovač - API
//  Uživatelské akce (session): login, logout, status, upload,
//      list, job, download, result, save_edits, delete,
//      request_burnin, download_burnin
//  Workerské akce (token):     worker_claim, worker_source,
//      worker_progress, worker_result, worker_fail,
//      worker_burnin_srt, worker_burnin_result
// ============================================================
require_once __DIR__ . '/lib.php';
ensure_dirs();

$action = $_GET['action'] ?? $_POST['action'] ?? '';

switch ($action) {

// ---------- LOGIN / LOGOUT / STATUS ----------------------------------------
case 'login':
    start_sess();
    $u = (string)($_POST['user'] ?? '');
    $p = (string)($_POST['pass'] ?? '');
    $res = find_user($u, $p);
    if ($res) {
        $_SESSION['auth'] = true;
        $_SESSION['user'] = $res['user'];
        $_SESSION['role'] = $res['role'];
        jsend(['ok' => true, 'user' => $res['user'], 'role' => $res['role']]);
    }
    usleep(400000);  // malé zdržení proti hádání hesla
    jsend(['error' => 'Špatné jméno nebo heslo'], 401);

case 'logout':
    start_sess();
    $_SESSION = [];
    @session_destroy();
    jsend(['ok' => true]);

case 'status':
    jsend([
        'logged_in'    => is_logged_in(),
        'user'         => $_SESSION['user'] ?? null,
        'role'         => current_role(),
        'languages'    => LANGUAGES,
        'formats'      => OUT_FORMATS,
        'max_upload_mb'=> MAX_UPLOAD_MB,
    ]);

// ---------- UPLOAD ----------------------------------------------------------
case 'upload':
    require_login();
    if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'] ?? '')) {
        jsend(['error' => 'Chybí soubor'], 400);
    }
    $orig = $_FILES['file']['name'];
    $ext  = clean_ext(pathinfo($orig, PATHINFO_EXTENSION));
    if (!$ext) jsend(['error' => 'Nepodporovaný formát souboru'], 400);
    if ($_FILES['file']['size'] > MAX_UPLOAD_MB * 1024 * 1024) {
        jsend(['error' => 'Soubor je příliš velký (limit ' . MAX_UPLOAD_MB . ' MB)'], 400);
    }
    $lang = (string)($_POST['language'] ?? 'cs-CZ');
    if (!in_array($lang, LANGUAGES, true)) $lang = 'cs-CZ';
    $llm = (string)($_POST['llm'] ?? '1') === '1';
    $fmts = array_values(array_filter(
        explode(',', (string)($_POST['formats'] ?? 'txt,srt,vtt,json')),
        fn($f) => in_array($f, OUT_FORMATS, true)
    ));
    if (!$fmts) $fmts = OUT_FORMATS;

    $id = new_id();
    $dest = UP_DIR . '/' . $id . '.' . $ext;
    if (!move_uploaded_file($_FILES['file']['tmp_name'], $dest)) {
        jsend(['error' => 'Nepodařilo se uložit soubor (práva/limit?)'], 500);
    }
    $job = [
        'id' => $id, 'filename' => basename($orig), 'owner' => current_user(),
        'ext' => $ext, 'language' => $lang, 'llm' => $llm, 'formats' => $fmts,
        'status' => 'pending', 'progress' => 0,
        'created_at' => now(), 'updated_at' => now(),
        'finished_at' => null, 'error' => null,
        'duration' => 0, 'text_preview' => '', 'outputs' => [],
        'size' => (int)$_FILES['file']['size'],
    ];
    save_job($job);
    jsend(['ok' => true, 'job' => public_job($job)]);

// ---------- CHUNKED UPLOAD (obchází 413 limit hostingu) --------------------
// Velké soubory (mobil, dlouhá videa) se posílají po malých kouscích, takže
// žádný jednotlivý request nepřekročí limit velikosti těla na hostingu.
case 'upload_init':
    require_login();
    $orig = (string)($_POST['filename'] ?? '');
    $ext  = clean_ext(pathinfo($orig, PATHINFO_EXTENSION));
    if (!$ext) jsend(['error' => 'Nepodporovaný formát souboru'], 400);
    $lang = (string)($_POST['language'] ?? 'cs-CZ');
    if (!in_array($lang, LANGUAGES, true)) $lang = 'cs-CZ';
    $llm = (string)($_POST['llm'] ?? '1') === '1';
    $fmts = array_values(array_filter(
        explode(',', (string)($_POST['formats'] ?? 'txt,srt,vtt,json')),
        fn($f) => in_array($f, OUT_FORMATS, true)
    ));
    if (!$fmts) $fmts = OUT_FORMATS;
    $id = new_id();
    @file_put_contents(UP_DIR . '/' . $id . '.part', '');
    $job = [
        'id' => $id, 'filename' => basename($orig), 'owner' => current_user(),
        'ext' => $ext, 'language' => $lang, 'llm' => $llm, 'formats' => $fmts,
        'status' => 'uploading', 'progress' => 0,
        'created_at' => now(), 'updated_at' => now(),
        'finished_at' => null, 'error' => null,
        'duration' => 0, 'text_preview' => '', 'outputs' => [], 'size' => 0,
    ];
    save_job($job);
    jsend(['ok' => true, 'id' => $id]);

case 'upload_chunk':
    require_login();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j || !can_access($j) || ($j['status'] ?? '') !== 'uploading')
        jsend(['error' => 'Neplatné nahrávání'], 400);
    if (empty($_FILES['chunk']) || !is_uploaded_file($_FILES['chunk']['tmp_name'] ?? ''))
        jsend(['error' => 'Chybí část souboru'], 400);
    $part = UP_DIR . '/' . clean_id($j['id']) . '.part';
    $cur = is_file($part) ? filesize($part) : 0;
    if ($cur + (int)$_FILES['chunk']['size'] > MAX_UPLOAD_MB * 1024 * 1024)
        jsend(['error' => 'Soubor je příliš velký (limit ' . MAX_UPLOAD_MB . ' MB)'], 400);
    $in = fopen($_FILES['chunk']['tmp_name'], 'rb');
    $out = fopen($part, 'ab');
    if (!$in || !$out) jsend(['error' => 'Nelze zapsat část souboru'], 500);
    while (!feof($in)) fwrite($out, fread($in, 1 << 18));
    fclose($in); fclose($out);
    jsend(['ok' => true, 'received' => filesize($part)]);

case 'upload_finish':
    require_login();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j || !can_access($j) || ($j['status'] ?? '') !== 'uploading')
        jsend(['error' => 'Neplatné nahrávání'], 400);
    $part = UP_DIR . '/' . clean_id($j['id']) . '.part';
    $dest = UP_DIR . '/' . clean_id($j['id']) . '.' . clean_ext($j['ext']);
    if (!is_file($part) || filesize($part) === 0) jsend(['error' => 'Žádná data nenahrána'], 400);
    if (!@rename($part, $dest)) jsend(['error' => 'Nelze dokončit nahrávání'], 500);
    $j['size'] = filesize($dest);
    $j['status'] = 'pending';
    $j['updated_at'] = now();
    save_job($j);
    jsend(['ok' => true, 'job' => public_job($j)]);

// ---------- LIST / JOB DETAIL ----------------------------------------------
case 'list':
    require_login();
    $jobs = all_jobs();
    if (!is_admin()) {
        $me = current_user();
        $jobs = array_values(array_filter($jobs, fn($j) => ($j['owner'] ?? '') === $me));
    }
    // Pomocné joby (burnin/translate) nevypisujeme v hlavním seznamu
    $jobs = array_values(array_filter($jobs, fn($j) => !in_array($j['type'] ?? '', ['burnin', 'translate'], true)));
    jsend(['jobs' => array_map('public_job', $jobs)]);

case 'job':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    jsend(public_job($j));

// ---------- DOWNLOAD VÝSTUPU (uživatel) ------------------------------------
case 'download':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    $fmt = strtolower((string)($_GET['fmt'] ?? ''));
    if (!in_array($fmt, OUT_FORMATS, true)) jsend(['error' => 'Neplatný formát'], 400);
    $path = OUT_DIR . '/' . clean_id($j['id']) . '.' . $fmt;
    if (!is_file($path)) jsend(['error' => 'Výstup neexistuje'], 404);
    $base = pathinfo($j['filename'], PATHINFO_FILENAME);
    $mimes = ['txt'=>'text/plain','srt'=>'application/x-subrip','vtt'=>'text/vtt','json'=>'application/json'];
    header('Content-Type: ' . ($mimes[$fmt] ?? 'application/octet-stream') . '; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $base . '.' . $fmt . '"');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;

// ---------- VÝSLEDEK PRO EDITOR (segmenty + tokeny) ------------------------
case 'result':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    $path = OUT_DIR . '/' . clean_id($j['id']) . '.json';
    if (!is_file($path)) jsend(['error' => 'Výsledek (JSON) neexistuje'], 404);
    $doc = json_decode((string)file_get_contents($path), true);
    if (!is_array($doc)) jsend(['error' => 'Poškozený výsledek'], 500);
    jsend(['job' => public_job($j), 'result' => $doc]);

// ---------- ULOŽENÍ RUČNÍCH ÚPRAV + REGENERACE TITULKŮ ---------------------
case 'save_edits':
    require_login();
    $in = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($in)) jsend(['error' => 'Neplatná data'], 400);
    $j = load_job((string)($in['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    if (!is_array($in['segments'] ?? null)) jsend(['error' => 'Chybí segmenty'], 400);

    $id = clean_id($j['id']);
    $segs = []; $parts = [];
    foreach ($in['segments'] as $s) {
        $t = trim((string)($s['text'] ?? ''));
        $segs[] = ['start' => (float)($s['start'] ?? 0), 'end' => (float)($s['end'] ?? 0), 'text' => $t];
        if ($t !== '') $parts[] = $t;
    }
    $text = trim(implode(' ', $parts));
    $fmts = $j['formats'] ?? OUT_FORMATS;
    if (in_array('txt', $fmts, true))  file_put_contents(OUT_DIR . "/$id.txt", $text . "\n");
    if (in_array('srt', $fmts, true))  file_put_contents(OUT_DIR . "/$id.srt", gen_srt($segs));
    if (in_array('vtt', $fmts, true))  file_put_contents(OUT_DIR . "/$id.vtt", gen_vtt($segs));
    if (in_array('json', $fmts, true)) {
        $doc = json_decode((string)@file_get_contents(OUT_DIR . "/$id.json"), true);
        if (!is_array($doc)) $doc = [];
        $doc['text'] = $text; $doc['segments'] = $in['segments']; $doc['edited'] = true;
        file_put_contents(OUT_DIR . "/$id.json",
            json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    }
    // Pokud existuje burnin/překlad, invalidovat (titulky se změnily)
    $bi = load_burnin_job($id);
    if ($bi && in_array($bi['status'], ['done', 'error'], true)) {
        $bi['status'] = 'outdated';
        save_burnin_job($bi);
    }
    $tr = load_translate_job($id);
    if ($tr && in_array($tr['status'], ['done', 'error'], true)) {
        $tr['status'] = 'outdated';
        save_translate_job($tr);
    }
    $j['text_preview'] = function_exists('mb_substr') ? mb_substr($text, 0, 20000) : substr($text, 0, 20000);
    $j['edited'] = true;
    save_job($j);
    jsend(['ok' => true]);

// ---------- DELETE ----------------------------------------------------------
case 'delete':
    require_login();
    $j = load_job((string)($_REQUEST['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    // Smaž i případný burnin / překlad
    $bi = load_burnin_job($j['id']);
    if ($bi) delete_burnin_files($bi);
    $tr = load_translate_job($j['id']);
    if ($tr) delete_translate_files($tr);
    delete_job_files($j);
    jsend(['ok' => true, 'deleted' => $j['id']]);

// ---------- BURNIN: uživatel požádá o zapékání -----------------------------
case 'request_burnin':
    require_login();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    if (($j['status'] ?? '') !== 'done') jsend(['error' => 'Job není dokončen'], 400);
    $srt = OUT_DIR . '/' . clean_id($j['id']) . '.srt';
    if (!is_file($srt)) jsend(['error' => 'SRT soubor neexistuje – přidej SRT do formátů'], 400);
    $src = UP_DIR . '/' . clean_id($j['id']) . '.' . clean_ext($j['ext'] ?? '');
    if (!is_file($src)) jsend(['error' => 'Původní video již není k dispozici'], 400);

    // nastavení vzhledu titulků (font/velikost/pozice/výška/zalomení/tučně)
    $font = preg_replace('/[^A-Za-z0-9 ]/', '', (string)($_POST['font'] ?? 'Arial'));
    $align = (int)($_POST['pos'] ?? 2);
    $opts = [
        'font'    => ($font !== '' ? substr($font, 0, 40) : 'Arial'),
        'size'    => max(8, min(120, (int)($_POST['size'] ?? 24))),
        'align'   => in_array($align, [2, 5, 8], true) ? $align : 2,
        'marginv' => max(0, min(600, (int)($_POST['margin'] ?? 36))),
        'chars'   => max(0, min(120, (int)($_POST['chars'] ?? 42))),
        'bold'    => ((string)($_POST['bold'] ?? '0')) === '1',
    ];

    $bid = 'bi_' . clean_id($j['id']);
    $bi = [
        'id' => $bid, 'type' => 'burnin', 'source_id' => $j['id'],
        'ext' => $j['ext'], 'filename' => $j['filename'],
        'owner' => current_user(), 'opts' => $opts,
        'status' => 'pending', 'progress' => 0,
        'created_at' => now(), 'updated_at' => now(),
        'finished_at' => null, 'error' => null,
    ];
    save_burnin_job($bi);
    jsend(['ok' => true, 'burnin_id' => $bid, 'status' => 'pending']);

// ---------- BURNIN: stav a stažení -----------------------------------------
case 'burnin_status':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    $bi = load_burnin_job($j['id']);
    jsend(['burnin' => $bi ? burnin_public($bi) : null]);

case 'download_burnin':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    $path = BURNIN_DIR . '/' . clean_id($j['id']) . '_burned.mp4';
    if (!is_file($path)) jsend(['error' => 'Video s titulky není k dispozici'], 404);
    $base = pathinfo($j['filename'], PATHINFO_FILENAME);
    header('Content-Type: video/mp4');
    header('Content-Disposition: attachment; filename="' . $base . '_titulky.mp4' . '"');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;

// ---------- PŘEKLAD: požadavek / stav / stažení ----------------------------
case 'request_translate':
    require_login();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    if (($j['status'] ?? '') !== 'done') jsend(['error' => 'Job není dokončen'], 400);
    if (!is_file(OUT_DIR . '/' . clean_id($j['id']) . '.json'))
        jsend(['error' => 'Chybí JSON s titulky (přidej JSON do formátů)'], 400);
    $target = (string)($_POST['target'] ?? 'en-US');
    if (!in_array($target, TRANSLATE_TARGETS, true)) jsend(['error' => 'Nepodporovaný cílový jazyk'], 400);
    $tid = 'tr_' . clean_id($j['id']);
    $tr = [
        'id' => $tid, 'type' => 'translate', 'source_id' => $j['id'],
        'filename' => $j['filename'], 'owner' => current_user(), 'target' => $target,
        'status' => 'pending', 'progress' => 0,
        'created_at' => now(), 'updated_at' => now(), 'finished_at' => null, 'error' => null,
    ];
    save_translate_job($tr);
    jsend(['ok' => true, 'translate_id' => $tid, 'status' => 'pending']);

case 'translate_status':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    $tr = load_translate_job($j['id']);
    jsend(['translate' => $tr ? translate_public($tr) : null]);

case 'download_translate':
    require_login();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    $tr = load_translate_job($j['id']);
    if (!$tr) jsend(['error' => 'Překlad neexistuje'], 404);
    $fmt = strtolower((string)($_GET['fmt'] ?? 'srt'));
    if (!in_array($fmt, ['srt', 'vtt', 'txt'], true)) jsend(['error' => 'Neplatný formát'], 400);
    $t = preg_replace('/[^A-Za-z-]/', '', (string)($tr['target'] ?? ''));
    $path = OUT_DIR . '/' . clean_id($j['id']) . '.' . $t . '.' . $fmt;
    if (!is_file($path)) jsend(['error' => 'Soubor neexistuje'], 404);
    $base = pathinfo($j['filename'], PATHINFO_FILENAME);
    $mimes = ['srt' => 'application/x-subrip', 'vtt' => 'text/vtt', 'txt' => 'text/plain'];
    header('Content-Type: ' . $mimes[$fmt] . '; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $base . '.' . $t . '.' . $fmt . '"');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;

// ========== WORKER (token) =================================================

case 'worker_claim':
    require_worker();
    $picked = null;
    $jobs = array_reverse(all_jobs()); // nejstarší pending první
    foreach ($jobs as $j) {
        if (($j['status'] ?? '') === 'pending') { $picked = $j; break; }
    }
    // nic nečeká? znovu zařaď osiřelé joby (worker spadl při zpracování) –
    // processing/burning starší než 10 minut.
    if (!$picked) {
        $nowts = time();
        foreach ($jobs as $j) {
            $st = $j['status'] ?? '';
            if (($st === 'processing' || $st === 'burning')
                && ($nowts - strtotime($j['updated_at'] ?? '1970-01-01 00:00:00')) > 600) {
                $picked = $j;
                break;
            }
        }
    }
    if (!$picked) jsend(['job' => null]);
    $picked['status'] = 'processing';
    $picked['progress'] = 5;
    $picked['updated_at'] = now();
    save_job_any($picked);
    $jtype = $picked['type'] ?? 'transcribe';
    $payload = ['id' => $picked['id'], 'type' => $jtype];
    if ($jtype === 'burnin') {
        $payload['source_id'] = $picked['source_id'];
        $payload['ext']       = $picked['ext'];
        $payload['filename']  = $picked['filename'];
        $payload['opts']      = $picked['opts'] ?? null;
    } elseif ($jtype === 'translate') {
        $payload['source_id'] = $picked['source_id'];
        $payload['target']    = $picked['target'];
    } else {
        $payload['filename'] = $picked['filename'];
        $payload['ext']      = $picked['ext'];
        $payload['language'] = $picked['language'];
        $payload['llm']      = $picked['llm'] ?? true;
        $payload['formats']  = $picked['formats'];
    }
    jsend(['job' => $payload]);

case 'worker_source':
    require_worker();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    $ext = clean_ext($j['ext'] ?? '');
    $path = UP_DIR . '/' . clean_id($j['id']) . '.' . $ext;
    if (!$ext || !is_file($path)) jsend(['error' => 'Zdroj neexistuje'], 404);
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: attachment; filename="' . $j['id'] . '.' . $ext . '"');
    readfile($path);
    exit;

// Worker si stáhne SRT pro burnin job (ze zdrojového jobu)
case 'worker_burnin_srt':
    require_worker();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    $path = OUT_DIR . '/' . clean_id($j['id']) . '.srt';
    if (!is_file($path)) jsend(['error' => 'SRT nenalezeno'], 404);
    header('Content-Type: application/x-subrip; charset=utf-8');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;

case 'worker_progress':
    require_worker();
    $j = load_job_flexible((string)($_POST['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    if (isset($_POST['progress'])) $j['progress'] = max(0, min(100, (int)$_POST['progress']));
    if (!empty($_POST['status']))  $j['status'] = (string)$_POST['status'];
    $j['updated_at'] = now();
    save_job_any($j);
    jsend(['ok' => true]);

case 'worker_result':
    require_worker();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    $outputs = [];
    foreach (OUT_FORMATS as $fmt) {
        if (!empty($_FILES[$fmt]) && is_uploaded_file($_FILES[$fmt]['tmp_name'] ?? '')) {
            $dest = OUT_DIR . '/' . clean_id($j['id']) . '.' . $fmt;
            if (move_uploaded_file($_FILES[$fmt]['tmp_name'], $dest)) {
                $outputs[$fmt] = true;
            }
        }
    }
    $j['outputs'] = $outputs;
    $j['text_preview'] = (string)($_POST['text_preview'] ?? '');
    if (isset($_POST['duration'])) $j['duration'] = (float)$_POST['duration'];
    if (isset($_POST['fps']) && is_numeric($_POST['fps'])) $j['fps'] = (float)$_POST['fps'];
    $j['status'] = 'done';
    $j['progress'] = 100;
    $j['error'] = null;
    $j['finished_at'] = now();
    $j['updated_at'] = now();
    save_job($j);
    jsend(['ok' => true]);

// Worker nahraje výsledné zapečené video
case 'worker_burnin_result':
    require_worker();
    $j = load_job_flexible((string)($_POST['id'] ?? ''));
    if (!$j || ($j['type'] ?? '') !== 'burnin') jsend(['error' => 'Burnin job nenalezen'], 404);
    if (empty($_FILES['video']) || !is_uploaded_file($_FILES['video']['tmp_name'] ?? '')) {
        jsend(['error' => 'Chybí video soubor'], 400);
    }
    $dest = BURNIN_DIR . '/' . clean_id($j['source_id']) . '_burned.mp4';
    if (!move_uploaded_file($_FILES['video']['tmp_name'], $dest)) {
        jsend(['error' => 'Nepodařilo se uložit video'], 500);
    }
    $j['status'] = 'done';
    $j['progress'] = 100;
    $j['error'] = null;
    $j['finished_at'] = now();
    $j['updated_at'] = now();
    save_burnin_job($j);
    jsend(['ok' => true]);

// Worker si stáhne zdrojový JSON se segmenty (pro překlad)
case 'worker_source_json':
    require_worker();
    $j = load_job((string)($_GET['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    $path = OUT_DIR . '/' . clean_id($j['id']) . '.json';
    if (!is_file($path)) jsend(['error' => 'JSON nenalezen'], 404);
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;

// Worker nahraje přeložené titulky
case 'worker_translate_result':
    require_worker();
    $j = load_job_flexible((string)($_POST['id'] ?? ''));
    if (!$j || ($j['type'] ?? '') !== 'translate') jsend(['error' => 'Překlad nenalezen'], 404);
    $src = clean_id($j['source_id']);
    $t = preg_replace('/[^A-Za-z-]/', '', (string)($j['target'] ?? ''));
    foreach (['srt', 'vtt', 'txt'] as $fmt) {
        if (!empty($_FILES[$fmt]) && is_uploaded_file($_FILES[$fmt]['tmp_name'] ?? '')) {
            move_uploaded_file($_FILES[$fmt]['tmp_name'], OUT_DIR . '/' . $src . '.' . $t . '.' . $fmt);
        }
    }
    $j['text_preview'] = (string)($_POST['text_preview'] ?? '');
    $j['status'] = 'done';
    $j['progress'] = 100;
    $j['error'] = null;
    $j['finished_at'] = now();
    $j['updated_at'] = now();
    save_translate_job($j);
    jsend(['ok' => true]);

case 'worker_fail':
    require_worker();
    $j = load_job_flexible((string)($_POST['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    $j['status'] = 'error';
    $j['error'] = mb_substr((string)($_POST['error'] ?? 'neznámá chyba'), 0, 1000);
    $j['finished_at'] = now();
    $j['updated_at'] = now();
    save_job_any($j);
    jsend(['ok' => true]);

default:
    jsend(['error' => 'Neznámá akce'], 400);
}
