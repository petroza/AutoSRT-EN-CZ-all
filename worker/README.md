# PZ ASR Studio

**Lokální offline přepis audia a videa do textu pro Windows 10/11.**
Běží 100 % na tvém počítači, **bez cloudu** a **bez odesílání audia na internet**.
ASR (rozpoznávání řeči) zajišťuje **[parakeet.cpp](https://github.com/mudler/parakeet.cpp)** —
CPU runtime pro modely NVIDIA Parakeet / Nemotron ve formátu GGUF.

Doporučený model pro **offline přepis souborů**: **parakeet-tdt-0.6b-v3** (25 evropských
jazyků včetně češtiny) — pro nahrané soubory je výrazně přesnější. Model
**NVIDIA Nemotron-3.5-ASR-Streaming-0.6B** je optimalizovaný na nízkou latenci
(živý mikrofon), a proto u souborů bývá méně přesný. Oba běží **i bez GPU, jen na CPU**.

---

## Co aplikace umí

- Přepis souborů: **WAV, MP3, MP4, MOV, M4A, MKV** (+ AAC, FLAC, OGG, OPUS, WEBM, AVI)
- U videa/komprimovaného audia automaticky **extrahuje a převede zvuk přes ffmpeg**
  na **16 kHz / mono / PCM** (formát, který parakeet.cpp vyžaduje)
- Výstupy: **TXT, SRT, VTT, JSON s časovými značkami** + náhled textu v aplikaci
- Výběr jazyka: **Auto / Čeština cs-CZ / Angličtina en-US / Ukrajinština uk-UA** (priorita čeština)
- Tmavé broadcast/newsroom rozhraní, drag & drop, progress, log, historie jobů
- Diagnostický panel (Python / ffmpeg / parakeet.cpp / model / CPU režim)

---

## Rychlý start (5 kroků)

1. **Rozbal ZIP** kamkoliv (např. `C:\PZ_ASR_Studio`).
2. Spusť **`INSTALL.bat`** — zkontroluje Python, vytvoří `.venv`, nainstaluje závislosti
   a vypíše, co ještě chybí (ffmpeg / parakeet.cpp / model).
3. **Vlož model** `*.gguf` do složky **`models\`** (viz níže).
4. **Vlož `parakeet-cli.exe`** do **`tools\parakeet\`** a (pokud nemáš ffmpeg v PATH)
   `ffmpeg.exe` + `ffprobe.exe` do **`tools\ffmpeg\`**.
5. Spusť **`START.bat`** → otevře se prohlížeč na **http://127.0.0.1:8787**.

Kdykoliv můžeš spustit **`CHECK.bat`** pro přehled stavu (Python, venv, ffmpeg,
parakeet, model, zápis do složek, volný port 8787).

---

## Co je potřeba doplnit ručně (a kam)

### 1) Model GGUF → `models\`
Stáhni z **https://huggingface.co/mudler/parakeet-cpp-gguf** jeden soubor, ideálně:

```
tdt-0.6b-v3-q8_0.gguf
```

(menší/rychlejší: `q5_k` / `q4_k`, maximální kvalita: `f16`).
Stačí **jeden** `.gguf` ve složce `models\` — aplikace si ho najde sama
(preferuje `tdt-0.6b-v3`; pořadí priority je v `backend/config.py`).

Stažení přes CLI (volitelné):
```
huggingface-cli download mudler/parakeet-cpp-gguf tdt-0.6b-v3-q8_0.gguf --local-dir models
```

> Pro **budoucí živý mikrofon** je vhodnější streaming model
> `nemotron-3.5-asr-streaming-0.6b-*.gguf` (nízká latence). Když je ve složce
> víc modelů, appka offline přepis dělá přednostně přes `tdt-0.6b-v3`.

### 2) parakeet.cpp → `tools\parakeet\`
Stáhni předkompilovaný **Windows build (CPU)** z
**https://github.com/mudler/parakeet.cpp/releases** a dej soubor
`parakeet-cli.exe` do `tools\parakeet\`.
(Najde se i v podsložce, ale doporučeno dát `.exe` přímo sem.)

### 3) ffmpeg → `tools\ffmpeg\` (pokud není v PATH)
Stáhni „release essentials" z **https://www.gyan.dev/ffmpeg/builds/**
a zkopíruj `ffmpeg.exe` + `ffprobe.exe` do `tools\ffmpeg\`.

---

## Použití

1. Přetáhni soubor do drop zóny (nebo klikni a vyber).
2. Vyber **jazyk** a zaškrtni požadované **výstupy** (TXT/SRT/VTT/JSON).
3. Klikni **Přepsat**.
4. Sleduj **progress** a **log**. Po dokončení se zobrazí **náhled** a tlačítka pro stažení.
5. **Historie** vlevo dole drží poslední přepisy — kliknutím je znovu otevřeš, křížkem smažeš.

Hotové výstupy najdeš i na disku ve složce **`outputs\`**.

---

## Jak to funguje (architektura)

```
[ Prohlížeč / UI ]  ──HTTP──>  [ FastAPI backend :8787 ]
   frontend/                       backend/main.py
                                        │
            ┌───────────────────────────┼───────────────────────────┐
            ▼                           ▼                            ▼
   ffmpeg_tools.py             asr_engine.py                  exporters.py
  (video/audio → WAV       (volá parakeet-cli.exe,        (TXT / SRT / VTT /
   16k mono PCM)            čte JSON s časy slov)           JSON na disk)
            │                           │                            │
            └──────────── job_manager.py (stav jobů = JSON v jobs/) ──┘
```

**Pipeline jobu:** `uploaded → converting_audio → ready_for_asr → transcribing → exporting → done`
(při chybě `error`). Stav, progress a log se průběžně ukládají a UI je poolingem zobrazuje.

Celé volání parakeet.cpp je **izolováno v `backend/asr_engine.py`** ve funkci
`build_transcribe_command()`. Spouští se přesně:

```
parakeet-cli transcribe --model models\<model>.gguf --input <audio>.wav --json
```

`--json` vrací text + **časy jednotlivých slov**, ze kterých se skládají titulkové
segmenty. Pokud by konkrétní build `parakeet-cli` neuměl některý flag (např. `--lang`),
engine příkaz automaticky zopakuje bez něj (model si jazyk detekuje sám).

---

## Konfigurace (volitelné)

Vše je v `backend/config.py`, případně přes proměnné prostředí:

| Proměnná | Výchozí | Význam |
|---|---|---|
| `PZ_PORT` | `8787` | port serveru |
| `PZ_MODEL_PATH` | (auto) | přímá cesta ke konkrétnímu `.gguf` |
| `PZ_PARAKEET_EXE` | (auto) | přímá cesta k `parakeet-cli.exe` |
| `PZ_FFMPEG_EXE` / `PZ_FFPROBE_EXE` | (auto) | přímá cesta k ffmpeg/ffprobe |
| `PZ_PARAKEET_THREADS` | (výchozí) | počet vláken CPU, např. `4` |
| `PZ_PARAKEET_DECODER` | (auto) | vynutí dekodér `ctc` nebo `tdt` |
| `PZ_PARAKEET_SEND_LANG` | `1` | posílat jazykový flag (`0` = vždy auto-detekce) |
| `PZ_PARAKEET_TIMEOUT` | `0` | timeout přepisu v s (0 = bez limitu) |

---

## Řešení častých chyb

**„parakeet.cpp (parakeet-cli) nebyl nalezen"**
→ Chybí `parakeet-cli.exe` v `tools\parakeet\` (nebo v PATH). Viz krok 2 výše.

**„Nenašel jsem žádný .gguf model"**
→ Vlož model do `models\`. Viz krok 1 výše.

**„ffmpeg nebyl nalezen"**
→ Dej `ffmpeg.exe` + `ffprobe.exe` do `tools\ffmpeg\` nebo nainstaluj ffmpeg do PATH.

**„ASR backend není připojen / chyba ASR"**
→ Upload i konverze proběhly, ale parakeet.cpp selhal. Otevři log jobu
(tlačítko v UI nebo soubor `logs\<job_id>.log`) — je tam přesný příkaz i výpis chyby.
Vyzkoušej ruční spuštění: `tools\parakeet\parakeet-cli.exe transcribe --model models\<model>.gguf --input uploads\<job>.wav --json`.

**Port 8787 je obsazený**
→ Spusť `CHECK.bat`, nebo nastav jiný port: `set PZ_PORT=8799` a pak `START.bat`.

**Špatná čeština / přepis nedává smysl**
→ Zkus kvalitnější kvantizaci modelu (`q6_k`, `q8_0`, `f16`) nebo nastav jazyk
explicitně na `Čeština cs-CZ` místo `Auto`.

**`pip install` selže**
→ INSTALL.bat potřebuje internet jen pro stažení Pythonových balíčků. Žádné audio se
nikam neposílá. Zkontroluj připojení / firewall pro pip.

---

## Jak přidat jiný ASR backend

Engine je oddělený. Stačí v `backend/asr_engine.py` upravit / nahradit funkci
`transcribe_file(input_wav_path, language, job_id, duration, log)` tak, aby vracela:

```python
{
  "text": "...",
  "segments": [{"start": 0.0, "end": 2.5, "text": "..."}],
  "words": [ ... volitelně ... ],
}
```

Zbytek aplikace (export, UI, joby) se nemění. Pro úpravu CLI parakeetu stačí
sáhnout jen do `build_transcribe_command()`.

---

## Jak později doplnit živý mikrofon

Aplikace je na to připravená:
1. parakeet.cpp má **streaming/EOU režim** (`--stream`) — `config.PARAKEET_STREAM`.
2. Přidej endpoint `WebSocket /api/live`, který bude streamovat audio chunky z prohlížeče
   (Web Audio API / `MediaRecorder`) do `parakeet-cli ... --stream` (stdin/pipe).
3. Ve frontendu přidej tlačítko „Živě" a průběžně vykresluj částečné výsledky.

Stejná vrstva umožní i další rozšíření: **přepis živého vysílání, automatické titulky
pro newsroom, batch přepis více souborů, hledání v archivu videí, detekci řečníků,
editaci SRT v UI a export pro Premiere / DaVinci / Avid.**

---

## Zdroje / odkazy

- Model: https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b
- CPU runtime: https://github.com/mudler/parakeet.cpp
- GGUF modely: https://huggingface.co/mudler/parakeet-cpp-gguf

---

## Struktura projektu

```
PZ_ASR_Studio/
├─ backend/        FastAPI + pipeline (config, main, job_manager, asr_engine, ffmpeg_tools, exporters)
├─ frontend/       index.html, app.js, style.css
├─ models/         <— sem GGUF model
├─ tools/parakeet/ <— sem parakeet-cli.exe
├─ tools/ffmpeg/   <— sem ffmpeg.exe + ffprobe.exe (není-li v PATH)
├─ uploads/  outputs/  jobs/  logs/
├─ INSTALL.bat  START.bat  CHECK.bat
├─ requirements.txt  README.md
```

> **Soukromí:** Žádné cloud API. Audio ani text neopouští tvůj počítač.
> Jediné připojení k internetu je při `INSTALL.bat` (pip) a při ručním stažení modelu/runtime.
