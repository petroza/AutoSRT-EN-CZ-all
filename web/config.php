<?php
// ============================================================
//  PZ Titulkovač - konfigurace webu
//  (běží na PHP hostingu Forpsi, /www/titulkovac/)
// ============================================================

// --- Účty do webu --------------------------------------------------------
// role 'admin' vidí VŠECHNY zakázky; role 'user' vidí JEN svoje (admina nevidí).
// !!! DŮLEŽITÉ: doplň skutečná hesla místo hvězdiček !!!
const USERS = [
    'admin' => ['pass' => 'ZMEN_ME_heslo_admin', 'role' => 'admin'],
    'user'  => ['pass' => 'ZMEN_ME_heslo_user',  'role' => 'user'],
];

// --- Token pro workera ---------------------------------------------------
// MUSÍ být STEJNÝ jako "worker_token" ve worker_config.json u workera.
// Vygeneruj si vlastní náhodný, např.:  python -c "import secrets;print(secrets.token_hex(24))"
const WORKER_TOKEN = 'ZMEN_NA_VLASTNI_TAJNY_TOKEN';

// --- Limity / povolené hodnoty -------------------------------------------
const MAX_UPLOAD_MB = 500;
const ALLOWED_EXT  = ['wav','mp3','mp4','mov','m4a','mkv','aac','flac','ogg','opus','webm','avi'];
const LANGUAGES    = ['auto','cs-CZ','en-US','uk-UA'];
const OUT_FORMATS  = ['txt','srt','vtt','json'];

// --- Cesty (data mimo přímý web přístup, chráněno .htaccess) -------------
define('DATA_DIR',   __DIR__ . '/data');
define('UP_DIR',    DATA_DIR . '/uploads');
define('OUT_DIR',   DATA_DIR . '/outputs');
define('JOB_DIR',   DATA_DIR . '/jobs');
define('BURNIN_DIR', DATA_DIR . '/burnin');
