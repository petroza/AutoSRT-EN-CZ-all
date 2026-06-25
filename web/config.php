<?php
// ============================================================
//  PZ Titulkovač - konfigurace webu  (ŠABLONA / placeholdery)
//  (běží na PHP hostingu Forpsi, /www/titulkovac/)
//  POZOR: do gitu commitovat JEN placeholdery. Skutečná hesla a token
//  drž jen v nasazené verzi na serveru, NIKDY ne v repozitáři.
// ============================================================

// --- Účty do webu --------------------------------------------------------
// role 'admin' vidí VŠECHNY zakázky; role 'user' vidí JEN svoje (admina nevidí).
// Hesla jsou bcrypt hash (password_hash); ověřuje se password_verify.
// Hash vygeneruješ:  php -r 'echo password_hash("MojeHeslo", PASSWORD_DEFAULT);'
const USERS = [
    'PetrZ' => ['pass' => '$2y$10$REPLACE_WITH_YOUR_OWN_BCRYPT_HASH______________________', 'role' => 'admin'],
    'user'  => ['pass' => '$2y$10$REPLACE_WITH_YOUR_OWN_BCRYPT_HASH______________________', 'role' => 'user'],
];

// --- Token pro workera ---------------------------------------------------
// MUSÍ být STEJNÝ jako "worker_token" ve worker_config.json u workera.
// Vygeneruj náhodný:  php -r 'echo bin2hex(random_bytes(24));'
const WORKER_TOKEN = 'REPLACE_WITH_YOUR_OWN_RANDOM_TOKEN';

// --- Limity / povolené hodnoty -------------------------------------------
const MAX_UPLOAD_MB = 2048;   // chunked upload obchází limit těla requestu na hostingu
const ALLOWED_EXT  = ['wav','mp3','mp4','mov','m4a','mkv','aac','flac','ogg','opus','webm','avi'];
const LANGUAGES    = ['auto','cs-CZ','en-US','uk-UA','ru-RU'];
const OUT_FORMATS  = ['txt','srt','vtt','json'];
// cílové jazyky pro překlad titulků (po přepisu)
const TRANSLATE_TARGETS = ['cs-CZ','en-US','uk-UA','ru-RU','de-DE','sk-SK','pl-PL','es-ES','fr-FR','it-IT'];

// --- Cesty (data mimo přímý web přístup, chráněno .htaccess) -------------
define('DATA_DIR',   __DIR__ . '/data');
define('UP_DIR',     DATA_DIR . '/uploads');
define('OUT_DIR',    DATA_DIR . '/outputs');
define('JOB_DIR',    DATA_DIR . '/jobs');
define('BURNIN_DIR', DATA_DIR . '/burnin');
