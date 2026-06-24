<?php
// ============================================================
//  PZ Titulkovač - API
//  Uživatelské akce (session): login, logout, status, upload,
//      list, job, download, delete
//  Workerské akce (token):     worker_claim, worker_source,
//      worker_progress, worker_result, worker_fail
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
    $llm = (string)($_POST['llm'] ?? '1') === '1';   // automatická oprava cizích slov (Ollama)
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
        'id' => $id,
        'filename' => basename($orig),
        'owner' => current_user(),
        'ext' => $ext,
        'language' => $lang,
        'llm' => $llm,
        'formats' => $fmts,
        'status' => 'pending',
        'progress' => 0,
        'created_at' => now(),
        'updated_at' => now(),
        'finished_at' => null,
        'error' => null,
        'duration' => 0,
        'text_preview' => '',
        'outputs' => [],
        'size' => (int)$_FILES['file']['size'],
    ];
    save_job($job);
    jsend(['ok' => true, 'job' => public_job($job)]);

// ---------- LIST / JOB DETAIL ----------------------------------------------
case 'list':
    require_login();
    $jobs = all_jobs();
    if (!is_admin()) {
        $me = current_user();
        $jobs = array_values(array_filter($jobs, fn($j) => ($j['owner'] ?? '') === $me));
    }
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
    $segs = [];
    $parts = [];
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
        $doc['text'] = $text;
        $doc['segments'] = $in['segments'];
        $doc['edited'] = true;
        file_put_contents(OUT_DIR . "/$id.json",
            json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    }
    $j['text_preview'] = function_exists('mb_substr') ? mb_substr($text, 0, 20000) : substr($text, 0, 20000);
    $j['edited'] = true;
    save_job($j);
    jsend(['ok' => true]);

// ---------- DELETE (uživatel) ----------------------------------------------
case 'delete':
    require_login();
    $j = load_job((string)($_REQUEST['id'] ?? ''));
    if (!$j || !can_access($j)) jsend(['error' => 'Job nenalezen'], 404);
    delete_job_files($j);
    jsend(['ok' => true, 'deleted' => $j['id']]);

// ========== WORKER (token) =================================================

// Worker si vyzvedne nejstarší čekající job a označí ho jako "processing".
case 'worker_claim':
    require_worker();
    $picked = null;
    $jobs = all_jobs();          // seřazeno od nejnovějšího
    $jobs = array_reverse($jobs); // chceme nejstarší pending
    foreach ($jobs as $j) {
        if (($j['status'] ?? '') === 'pending') { $picked = $j; break; }
    }
    if (!$picked) jsend(['job' => null]);   // nic k práci
    $picked['status'] = 'processing';
    $picked['progress'] = 5;
    $picked['updated_at'] = now();
    save_job($picked);
    jsend(['job' => [
        'id' => $picked['id'],
        'filename' => $picked['filename'],
        'ext' => $picked['ext'],
        'language' => $picked['language'],
        'llm' => $picked['llm'] ?? true,
        'formats' => $picked['formats'],
    ]]);

// Worker stáhne zdrojové médium.
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

// Worker hlásí průběh.
case 'worker_progress':
    require_worker();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    if (isset($_POST['progress'])) $j['progress'] = max(0, min(100, (int)$_POST['progress']));
    if (!empty($_POST['status']))  $j['status'] = (string)$_POST['status'];
    $j['updated_at'] = now();
    save_job($j);
    jsend(['ok' => true]);

// Worker nahraje výsledky a označí job jako hotový.
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
    $j['status'] = 'done';
    $j['progress'] = 100;
    $j['error'] = null;
    $j['finished_at'] = now();
    $j['updated_at'] = now();
    save_job($j);
    jsend(['ok' => true]);

// Worker hlásí chybu.
case 'worker_fail':
    require_worker();
    $j = load_job((string)($_POST['id'] ?? ''));
    if (!$j) jsend(['error' => 'Job nenalezen'], 404);
    $j['status'] = 'error';
    $j['error'] = mb_substr((string)($_POST['error'] ?? 'neznámá chyba'), 0, 1000);
    $j['finished_at'] = now();
    $j['updated_at'] = now();
    save_job($j);
    jsend(['ok' => true]);

default:
    jsend(['error' => 'Neznámá akce'], 400);
}
