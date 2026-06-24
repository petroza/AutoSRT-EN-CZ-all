<?php
// ============================================================
//  PZ Titulkovač - konfigurace webu
//  (běží na PHP hostingu Forpsi, /www/titulkovac/)
// ============================================================

// --- Účty do webu --------------------------------------------------------
// role 'admin' vidí VŠECHNY zakázky; role 'user' vidí JEN svoje (admina nevidí).
// !!! DŮLEŽITÉ: doplň skutečná hesla místo hvězdiček !!!
const USERS = [
    'PetrZ' => ['pass' => '2022UA***',      'role' => 'admin'],
    'user'  => ['pass' => 'Grafika2026***', 'role' => 'user'],
];

// --- Token pro workera ---------------------------------------------------
// MUSÍ být STEJNÝ jako "worker_token" ve worker_config.json u workera.
const WORKER_TOKEN = 'd839656e2cb8512f7e41dedd020dce525564f2697c87feb7';

// --- Limity / povolené hodnoty -------------------------------------------
const MAX_UPLOAD_MB = 500;
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
