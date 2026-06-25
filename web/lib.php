<?php
require_once __DIR__ . '/config.php';

function ensure_dirs(): void {
    foreach ([DATA_DIR, UP_DIR, OUT_DIR, JOB_DIR, BURNIN_DIR] as $d) {
        if (!is_dir($d)) @mkdir($d, 0775, true);
    }
}

function jsend($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function start_sess(): void {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_name('TITKOV');
        @session_start();
    }
}

function is_logged_in(): bool {
    start_sess();
    return !empty($_SESSION['auth']);
}

function require_login(): void {
    if (!is_logged_in()) jsend(['error' => 'Nepřihlášeno'], 401);
}

function require_worker(): void {
    $tok = $_SERVER['HTTP_X_WORKER_TOKEN'] ?? ($_REQUEST['token'] ?? '');
    if (!is_string($tok) || !hash_equals(WORKER_TOKEN, $tok)) {
        jsend(['error' => 'Neplatný worker token'], 403);
    }
}

// Ověří jméno+heslo proti USERS, vrátí ['user'=>..,'role'=>..] nebo null.
function find_user(string $u, string $p): ?array {
    foreach (USERS as $name => $info) {
        // porovnání v konstantním čase, odolné proti časovému útoku
        if (hash_equals($name, $u) && hash_equals((string)$info['pass'], $p)) {
            return ['user' => $name, 'role' => $info['role']];
        }
    }
    return null;
}

function current_user(): ?string { start_sess(); return $_SESSION['user'] ?? null; }
function current_role(): string  { start_sess(); return $_SESSION['role'] ?? ''; }
function is_admin(): bool         { return current_role() === 'admin'; }

// Admin vidí vše; běžný uživatel jen svoje zakázky.
function can_access(array $job): bool {
    if (!is_logged_in()) return false;
    if (is_admin()) return true;
    return ($job['owner'] ?? '') === current_user();
}

function clean_id(string $id): string {
    return preg_replace('/[^a-f0-9]/', '', $id);
}

function clean_ext(string $ext): string {
    $ext = strtolower(preg_replace('/[^a-z0-9]/i', '', $ext));
    return in_array($ext, ALLOWED_EXT, true) ? $ext : '';
}

function job_path(string $id): string {
    return JOB_DIR . '/' . clean_id($id) . '.json';
}

function load_job(string $id): ?array {
    $p = job_path($id);
    if (!is_file($p)) return null;
    $j = json_decode((string)file_get_contents($p), true);
    return is_array($j) ? $j : null;
}

function save_job(array $job): void {
    file_put_contents(job_path($job['id']),
        json_encode($job, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
}

function save_burnin_job(array $bi): void {
    file_put_contents(burnin_job_path($bi['source_id'] ?? ''),
        json_encode($bi, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
}

function load_job_flexible(string $id): ?array {
    // POZOR: prefix musí mít přednost před load_job(); clean_id by u 'tr_'
    // odstranil t/r (nejsou hex) a omylem trefil zdrojový job.
    if (strncmp($id, 'bi_', 3) === 0) return load_burnin_job(substr($id, 3));
    if (strncmp($id, 'tr_', 3) === 0) return load_translate_job(substr($id, 3));
    return load_job($id);
}

function save_job_any(array $j): void {
    $t = $j['type'] ?? '';
    if ($t === 'burnin') save_burnin_job($j);
    elseif ($t === 'translate') save_translate_job($j);
    else save_job($j);
}

// --- překladové joby (tr_{source_id}.json) ---
function translate_job_path(string $source_id): string {
    return JOB_DIR . '/tr_' . clean_id($source_id) . '.json';
}
function load_translate_job(string $source_id): ?array {
    $p = translate_job_path($source_id);
    if (!is_file($p)) return null;
    $j = json_decode((string)file_get_contents($p), true);
    return is_array($j) ? $j : null;
}
function save_translate_job(array $tr): void {
    file_put_contents(translate_job_path($tr['source_id'] ?? ''),
        json_encode($tr, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
}
function translate_public(array $tr): array {
    return [
        'id' => $tr['id'] ?? '', 'status' => $tr['status'] ?? 'pending',
        'progress' => (int)($tr['progress'] ?? 0), 'error' => $tr['error'] ?? null,
        'target' => $tr['target'] ?? '', 'finished_at' => $tr['finished_at'] ?? null,
        'text' => $tr['text_preview'] ?? '',
    ];
}
function delete_translate_files(array $tr): void {
    $src = clean_id($tr['source_id'] ?? '');
    $t = preg_replace('/[^A-Za-z-]/', '', (string)($tr['target'] ?? ''));
    foreach (['srt', 'vtt', 'txt'] as $fmt) @unlink(OUT_DIR . '/' . $src . '.' . $t . '.' . $fmt);
    @unlink(translate_job_path($src));
}

function all_jobs(): array {
    $out = [];
    foreach (glob(JOB_DIR . '/*.json') as $f) {
        $j = json_decode((string)file_get_contents($f), true);
        if (is_array($j)) $out[] = $j;
    }
    usort($out, fn($a, $b) => strcmp($b['created_at'] ?? '', $a['created_at'] ?? ''));
    return $out;
}

function delete_job_files(array $job): void {
    $id = clean_id($job['id']);
    $ext = clean_ext($job['ext'] ?? '');
    if ($ext) @unlink(UP_DIR . '/' . $id . '.' . $ext);
    @unlink(UP_DIR . '/' . $id . '.part');   // nedokončený chunked upload
    foreach (OUT_FORMATS as $fmt) @unlink(OUT_DIR . '/' . $id . '.' . $fmt);
    @unlink(job_path($id));
}

function burnin_job_path(string $source_id): string {
    return JOB_DIR . '/bi_' . clean_id($source_id) . '.json';
}

function load_burnin_job(string $source_id): ?array {
    $p = burnin_job_path($source_id);
    if (!is_file($p)) return null;
    $j = json_decode((string)file_get_contents($p), true);
    return is_array($j) ? $j : null;
}

function burnin_public(array $bi): array {
    return [
        'id'          => $bi['id'] ?? '',
        'status'      => $bi['status'] ?? 'pending',
        'progress'    => (int)($bi['progress'] ?? 0),
        'error'       => $bi['error'] ?? null,
        'created_at'  => $bi['created_at'] ?? '',
        'finished_at' => $bi['finished_at'] ?? null,
    ];
}

function delete_burnin_files(array $bi): void {
    $src_id = clean_id($bi['source_id'] ?? '');
    if ($src_id) @unlink(BURNIN_DIR . '/' . $src_id . '_burned.mp4');
    @unlink(burnin_job_path($src_id));
}

function new_id(): string {
    return bin2hex(random_bytes(6));
}

// --- generátory titulků (pro regeneraci po ručních úpravách v editoru) ---
function ts_fmt(float $sec, string $sep): string {
    if ($sec < 0) $sec = 0.0;
    $ms = (int)round($sec * 1000);
    $h = intdiv($ms, 3600000); $ms %= 3600000;
    $m = intdiv($ms, 60000);   $ms %= 60000;
    $s = intdiv($ms, 1000);    $ms %= 1000;
    return sprintf('%02d:%02d:%02d%s%03d', $h, $m, $s, $sep, $ms);
}

function gen_srt(array $segs): string {
    $out = []; $i = 1;
    foreach ($segs as $s) {
        $out[] = (string)$i++;
        $out[] = ts_fmt((float)($s['start'] ?? 0), ',') . ' --> ' . ts_fmt((float)($s['end'] ?? 0), ',');
        $out[] = trim((string)($s['text'] ?? ''));
        $out[] = '';
    }
    return rtrim(implode("\n", $out)) . "\n";
}

function gen_vtt(array $segs): string {
    $out = ['WEBVTT', ''];
    foreach ($segs as $s) {
        $out[] = ts_fmt((float)($s['start'] ?? 0), '.') . ' --> ' . ts_fmt((float)($s['end'] ?? 0), '.');
        $out[] = trim((string)($s['text'] ?? ''));
        $out[] = '';
    }
    return rtrim(implode("\n", $out)) . "\n";
}

function now(): string {
    return date('Y-m-d H:i:s');
}

// Naparsuje SRT na segmenty [{start,end,text}] (časy v sekundách).
function parse_srt_segments(string $srt): array {
    $segs = [];
    $blocks = preg_split('/\r?\n\s*\r?\n/', trim($srt));
    foreach ($blocks as $b) {
        $lines = preg_split('/\r?\n/', trim($b));
        $ti = -1;
        foreach ($lines as $k => $l) { if (strpos($l, '-->') !== false) { $ti = $k; break; } }
        if ($ti < 0) continue;
        if (!preg_match('/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/', $lines[$ti], $m)) continue;
        $start = $m[1] * 3600 + $m[2] * 60 + $m[3] + $m[4] / 1000;
        $end   = $m[5] * 3600 + $m[6] * 60 + $m[7] + $m[8] / 1000;
        $text = trim(implode(' ', array_slice($lines, $ti + 1)));
        $segs[] = ['start' => $start, 'end' => $end, 'text' => $text];
    }
    return $segs;
}

// Veřejná (do UI/JSON) podoba jobu - bez interních cest.
function public_job(array $j): array {
    return [
        'id'           => $j['id'] ?? '',
        'filename'     => $j['filename'] ?? '',
        'owner'        => $j['owner'] ?? '',
        'language'     => $j['language'] ?? 'auto',
        'formats'      => $j['formats'] ?? OUT_FORMATS,
        'status'       => $j['status'] ?? 'pending',
        'progress'     => (int)($j['progress'] ?? 0),
        'created_at'   => $j['created_at'] ?? '',
        'finished_at'  => $j['finished_at'] ?? null,
        'error'        => $j['error'] ?? null,
        'duration'     => $j['duration'] ?? 0,
        'fps'          => isset($j['fps']) ? (float)$j['fps'] : null,
        'width'        => isset($j['width']) ? (int)$j['width'] : null,
        'height'       => isset($j['height']) ? (int)$j['height'] : null,
        'text_preview' => $j['text_preview'] ?? '',
        'outputs'      => $j['outputs'] ?? [],
        'size'         => (int)($j['size'] ?? 0),
    ];
}
