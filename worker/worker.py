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


def _download(url_params: dict, dest: Path) -> None:
    with requests.get(API, params=url_params, headers=HEAD,
                      stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                if chunk:
                    f.write(chunk)


def process(job):
    jid = job["id"]
    ext = job.get("ext") or "bin"
    lang = job.get("language") or "cs-CZ"
    formats = job.get("formats") or ["txt", "srt", "vtt", "json"]
    WORK.mkdir(parents=True, exist_ok=True)
    src = WORK / f"{jid}.{ext}"
    wav = WORK / f"{jid}.16k.wav"

    # 1) stáhni zdroj
    progress(jid, "processing", 10)
    _download({"action": "worker_source", "id": jid}, src)

    # detekce FPS + rozměrů (pro video; pro audio se použije fallback)
    fps = ffmpeg_tools.get_video_fps(src)
    vw, vh = ffmpeg_tools.get_video_size(src)

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
        if fps is not None:
            data["fps"] = fps
        if vw and vh:
            data["width"] = vw
            data["height"] = vh
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
    print(f"[OK] {jid} ({job.get('filename')}) hotovo, {dur:.1f}s audia"
          + (f", {fps:.3f} fps" if fps else ""))


def process_burnin(job):
    """Zapéct SRT titulky do videa pro daný burnin job."""
    jid     = job["id"]
    src_id  = job["source_id"]
    ext     = job.get("ext") or "mp4"
    WORK.mkdir(parents=True, exist_ok=True)

    src_video = WORK / f"{jid}_src.{ext}"
    src_srt   = WORK / f"{jid}_src.srt"
    out_mp4   = WORK / f"{jid}_burned.mp4"

    # 1) stáhni původní video
    progress(jid, "burning", 10)
    _download({"action": "worker_source", "id": src_id}, src_video)

    # 2) stáhni SRT ze zdrojového jobu (originál nebo překlad dle 'subs')
    progress(jid, "burning", 25)
    _download({"action": "worker_burnin_srt", "id": src_id,
               "subs": job.get("subs") or "original"}, src_srt)

    # 3) burn-in (s nastavením z webu a hlášením progresu enkódování 40..90 %)
    opts = job.get("opts") or {}
    # karaoke: stáhni JSON se segmenty + časy slov (vybarvování v rytmu řeči)
    if str(opts.get("mode")) == "karaoke":
        try:
            src_json = WORK / f"{jid}_src.json"
            _download({"action": "worker_source_json", "id": src_id}, src_json)
            opts["segments"] = json.loads(src_json.read_text(encoding="utf-8")).get("segments", [])
            src_json.unlink(missing_ok=True)
        except Exception as e:
            print(f"[BURN] karaoke JSON nedostupný, fallback na normál: {e}")
            opts["mode"] = "normal"
    _last = {"p": 0}

    def _cb(pct):
        mapped = 40 + int(pct * 0.5)          # enkódování 0..100 -> job 40..90
        if mapped - _last["p"] >= 4 or pct >= 100:   # throttle: ~à 4 %
            _last["p"] = mapped
            progress(jid, "burning", mapped)

    ffmpeg_tools.burn_subtitles(src_video, src_srt, out_mp4, opts=opts, progress_cb=_cb)

    # 4) nahraj výsledné video zpět
    progress(jid, "burning", 92)
    with open(out_mp4, "rb") as fh:
        rr = requests.post(API, params={"action": "worker_burnin_result"},
                           headers=HEAD,
                           data={"id": jid},
                           files={"video": (f"{jid}.mp4", fh)},
                           timeout=600)
        rr.raise_for_status()

    # úklid
    for p in [src_video, src_srt, out_mp4]:
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    print(f"[BURN] {jid} hotovo")


def process_translate(job):
    """Přeloží titulky hotového jobu do cílového jazyka (LLM) a nahraje zpět."""
    jid = job["id"]
    src_id = job["source_id"]
    target = job.get("target") or "en-US"
    WORK.mkdir(parents=True, exist_ok=True)

    # 1) stáhni zdrojový JSON se segmenty
    progress(jid, "translating", 8)
    src_json = WORK / f"{jid}_src.json"
    _download({"action": "worker_source_json", "id": src_id}, src_json)
    doc = json.loads(src_json.read_text(encoding="utf-8"))
    segs = doc.get("segments", [])
    n = len(segs) or 1

    # 2) přelož segment po segmentu (zachová časování)
    out_segs = []
    for i, s in enumerate(segs):
        txt = (s.get("text") or "").strip()
        tr = asr_engine.llm_translate(txt, target) if txt else txt
        if tr:  # korektura přeloženého textu (zachová cílový jazyk, opraví cizí slova/překlepy)
            tr = asr_engine._llm_correct_chunk(tr, target)
        out_segs.append({"start": s.get("start", 0), "end": s.get("end", 0), "text": tr})
        progress(jid, "translating", 8 + int((i + 1) / n * 82))

    # 3) export + nahrání
    full = " ".join(x["text"] for x in out_segs if x["text"]).strip()
    paths = exporters.export_all({"text": full, "segments": out_segs},
                                 WORK, jid + "_tr", ["srt", "vtt", "txt"],
                                 {"target": target, "source_id": src_id})
    progress(jid, "translating", 95)
    fhs, files = [], {}
    try:
        for fmt in ["srt", "vtt", "txt"]:
            p = paths.get(fmt)
            if p and Path(p).is_file():
                fh = open(p, "rb")
                fhs.append(fh)
                files[fmt] = (f"{jid}.{fmt}", fh)
        rr = requests.post(API, params={"action": "worker_translate_result"}, headers=HEAD,
                           data={"id": jid, "text_preview": full[:5000]},
                           files=files, timeout=180)
        rr.raise_for_status()
    finally:
        for fh in fhs:
            fh.close()
    for p in [src_json, *[Path(v) for v in paths.values()]]:
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
    print(f"[TR] {jid} -> {target} hotovo ({len(out_segs)} segmentů)")


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
        jtype = job.get("type", "transcribe")
        print(f"[JOB] {job['id']} | typ={jtype} | {job.get('filename', job.get('source_id', ''))}")
        try:
            if jtype == "burnin":
                process_burnin(job)
            elif jtype == "translate":
                process_translate(job)
            else:
                process(job)
        except Exception as e:
            traceback.print_exc()
            fail(job["id"], str(e))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nWorker ukončen.")
