# AutoSRT-EN-CZ-all

Lokální offline přepis řeči → **časované titulky (SRT/VTT/TXT/JSON)** pro češtinu
(+ angličtinu, ukrajinštinu a dalších ~25 evropských jazyků). Běží na CPU, **bez cloudu** —
audio neopouští tvůj počítač / tvůj web.

> *Local, offline speech-to-subtitles (Czech-first, multilingual). CPU-only, no cloud.
> ASR via parakeet.cpp + optional local LLM (Ollama) auto-correction of foreign words/brands.*

Jádro: **[parakeet.cpp](https://github.com/mudler/parakeet.cpp)** (CPU) + model
**parakeet-tdt-0.6b-v3** (GGUF). Volitelně **lokální LLM přes [Ollama](https://ollama.com)**,
který automaticky opraví foneticky přepsaná cizí slova a značky (`porše → Porsche`,
`Inijak → Enyaq`) — bez ručního slovníku.

---

## Dvě části

```
worker/   – lokální engine + worker (Windows, Python/FastAPI)
web/      – tenký web (PHP) pro frontu zakázek a stahování titulků (volitelné)
```

### A) `worker/` — lokální přepis (hlavní)
Samostatná appka i „worker" pro web. Pipeline: ffmpeg → WAV 16 kHz mono → parakeet.cpp →
(volitelně) LLM oprava → export TXT/SRT/VTT/JSON.

**Rychlý start (Windows):**
1. `worker/INSTALL.bat` – ověří Python 3.11+, vytvoří venv, nainstaluje závislosti.
2. Stáhni **model** do `worker/models/` — `tdt-0.6b-v3-q8_0.gguf`
   z <https://huggingface.co/mudler/parakeet-cpp-gguf>.
3. Stáhni **parakeet-cli.exe** (Win CPU build) do `worker/tools/parakeet/`
   z <https://github.com/mudler/parakeet.cpp/releases>.
4. Stáhni **ffmpeg.exe + ffprobe.exe** do `worker/tools/ffmpeg/` (není-li v PATH).
5. (Volitelně) nainstaluj **Ollama** a model (`ollama pull gemma4` apod.) pro automatickou
   opravu cizích slov.
6. Samostatně: `worker/START.bat` → <http://127.0.0.1:8787>.
   Jako worker k webu: `worker/START_WORKER.bat`.

Podrobnosti viz [`worker/README.md`](worker/README.md). Diagnostika: `worker/CHECK.bat`.

### B) `web/` — fronta a stahování (volitelné)
PHP web pro běžné PHP hostingy. Uživatel nahraje soubor, lokální `worker` ho vyzvedne,
přepíše a nahraje zpět. Web obsahuje:
- přihlášení (víc účtů, role admin/user — admin vidí vše, user jen svoje),
- přepínač automatické LLM opravy (Ollama) u nahrávání,
- **korektor titulků ve stylu Wordu**: opravená/nejistá slova podtržená vlnovkou,
  klik/tap → návrh / původní tvar / ruční přepis, „Opravit vše" a regenerace titulků,
- **export pro After Effects (.jsx)**: nastavíš velikost písma, počet znaků na řádek a
  jedno/dvouřádkové; vygeneruje ExtendScript, který v AE vloží časované textové vrstvy
  (dlouhé titulky se automaticky rozdělí), spuštění přes *File → Scripts → Run Script File*.

**Nasazení:** nahraj obsah `web/` na PHP hosting (vč. skrytých `.htaccess`/`.user.ini`).

---

## ⚠️ Nastavení tajného tokenu a hesel (POVINNÉ)
Repozitář obsahuje jen **vzory s placeholdery**. Před použitím nastav:
- **stejný** tajný `worker_token` ve `web/config.php` i `worker/worker_config.json`
  (vygeneruj: `python -c "import secrets;print(secrets.token_hex(24))"`),
- `base_url` ve `worker/worker_config.json` na adresu tvého webu,
- hesla účtů v `web/config.php`.

Modely, binárky (parakeet/ffmpeg) ani běhová data se do gitu nedávají (viz `.gitignore`).

---

## Soukromí
Veškerý přepis i LLM oprava běží **lokálně**. Web (pokud ho použiješ) jen řídí frontu a
ukládá text/titulky; samotné rozpoznávání ani volání LLM nejdou přes server.

## Licence
MIT © 2026 Petr Závorka — viz [LICENSE](LICENSE).

## Zdroje
- parakeet.cpp — <https://github.com/mudler/parakeet.cpp>
- GGUF modely — <https://huggingface.co/mudler/parakeet-cpp-gguf>
- NVIDIA Nemotron ASR — <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>
- Ollama — <https://ollama.com>
