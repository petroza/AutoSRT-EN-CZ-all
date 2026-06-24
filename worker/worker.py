"""
PZ Titulkovač - lokální worker.

Připojí se k webu (PHP fronta na Forpsi), vyzvedne čekající job, stáhne
médium, lokálně ho přepíše přes parakeet.cpp (model v models/) a nahraje
zpět TXT/SRT/VTT/JSON. Žádné audio nejde do cloudu - jen mezi tvým webem
a tímto PC.

Spouštěj přes START_WORKER.bat (aktivuje venv). Nastavení ve worker_config.json.
"""
from __future__ import annotations

import json
import os
import time
import traceback
from pathlib import Path

import requests

from backend import asr_engine, config, exporters, ffmpeg_tools

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / "worker_config.json").read_text(encoding="utf-8"))
# base_url / token lze pro test přepsat proměnnou prostředí
BASE = (os.environ.get("PZ_WORKER_BASE") or CFG["base_url"]).rstrip("/") + "/"
API = BASE + "api.php"
TOKEN = os.environ.get("PZ_WORKER_TOKEN") or CFG["worker_token"]
POLL = float(CFG.get("poll_interval_sec", 5))
HEAD = {"X-Worker-Token": TOKEN}

WORK = HERE / "worker_tmp"
WORK.mkdir(exist_ok=True)


def claim():
    r = requests.get(API, params={"action": "worker_claim"}, headers=HEAD, timeout=30)
    r.raise_for_status()
    return (r.json() or {}).get("job")


def progress(jid, status, pct):
    try:
        requests.post(API, params={"action": "worker_progress"}, headers=HEAD,
                      data={"id": jid, "status": status, "progress": int(pct)}, timeout=15)
    except Exception:
        pass


def fail(jid, msg):
    try:
        requests.post(API, params={"action": "worker_fail"}, headers=HEAD,
                      data={"id": jid, "error": str(msg)[:800]}, timeout=15)
    except Exception:
        pass


def process(job):
    jid = job["id"]
    ext = job.get("ext") or "bin"
    lang = job.get("language") or "cs-CZ"
    formats = job.get("formats") or ["txt", "srt", "vtt", "json"]
    WORK.mkdir(parents=True, exist_ok=True)   # robustně - složka mohla zmizet
    src = WORK / f"{jid}.{ext}"
    wav = WORK / f"{jid}.16k.wav"

    # 1) stáhni zdroj
    progress(jid, "processing", 10)
    with requests.get(API, params={"action": "worker_source", "id": jid},
                      headers=HEAD, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(src, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                if chunk:
                    f.write(chunk)

    # 2) konverze na WAV 16k mono
    progress(jid, "processing", 30)
    ffmpeg_tools.convert_to_wav(src, wav)
    dur = ffmpeg_tools.get_audio_duration(wav)

    # 3) přepis (parakeet.cpp) + volitelná LLM oprava (per-job přepínač z webu)
    progress(jid, "processing", 55)
    result = asr_engine.transcribe_file(str(wav), lang, jid, duration=dur,
                                        llm_correct=job.get("llm"))

    # 4) export do formátů
    progress(jid, "processing", 85)
    meta = {"job_id": jid, "filename": job.get("filename"), "language": lang,
            "duration": dur, "backend": result.get("backend"), "model": result.get("model")}
    paths = exporters.export_all(result, WORK, jid, formats, meta)

    # 5) nahraj výsledky zpět na web
    fhs, files = [], {}
    try:
        for fmt in ["txt", "srt", "vtt", "json"]:
            p = paths.get(fmt)
            if p and Path(p).is_file():
                fh = open(p, "rb")
                fhs.append(fh)
                files[fmt] = (f"{jid}.{fmt}", fh)
        data = {"id": jid, "duration": dur,
                "text_preview": (result.get("text") or "")[:20000]}
        rr = requests.post(API, params={"action": "worker_result"}, headers=HEAD,
                           data=data, files=files, timeout=300)
        rr.raise_for_status()
    finally:
        for fh in fhs:
            fh.close()

    # úklid dočasných souborů
    for p in [src, wav, *[Path(v) for v in paths.values()]]:
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    print(f"[OK] {jid} ({job.get('filename')}) hotovo, {dur:.1f}s audia")


def main():
    print("=" * 56)
    print(" PZ Titulkovač worker")
    print(" web:  ", BASE)
    print(" model:", (config.find_model().name if config.find_model() else "!! NENALEZEN !!"))
    print(" parakeet:", "OK" if config.find_parakeet_exe() else "!! NENALEZEN !!")
    print(" ffmpeg:  ", "OK" if config.find_ffmpeg() else "!! NENALEZEN !!")
    print("=" * 56)
    if not (config.find_parakeet_exe() and config.find_model() and config.find_ffmpeg()):
        print("VAROVÁNÍ: chybí nástroj/model - spusť CHECK.bat. Worker přesto poběží.")
    print("Čekám na zakázky (Ctrl+C ukončí)...")
    while True:
        try:
            job = claim()
        except Exception as e:
            print("[poll] web nedostupný:", e)
            time.sleep(max(POLL, 5))
            continue
        if not job:
            time.sleep(POLL)
            continue
        print(f"[JOB] {job['id']} | {job.get('filename')} | {job.get('language')}")
        try:
            process(job)
        except Exception as e:
            traceback.print_exc()
            fail(job["id"], str(e))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nWorker ukončen.")
