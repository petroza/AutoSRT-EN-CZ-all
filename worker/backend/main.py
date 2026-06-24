"""
PZ ASR Studio - FastAPI backend.

Spuštění (z kořene projektu):
    python -m uvicorn backend.main:app --host 127.0.0.1 --port 8787
"""
from __future__ import annotations

import platform
import shutil
import sys
import threading
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import asr_engine, config, exporters, ffmpeg_tools
from .job_manager import JobManager

config.ensure_dirs()

app = FastAPI(title="PZ ASR Studio", version="1.0.0")
jobs = JobManager()


# --- request modely -------------------------------------------------------
class TranscribeRequest(BaseModel):
    language: "str | None" = None
    formats: "list[str] | None" = None


# --- pipeline (běží v samostatném vlákně) ---------------------------------
def _process_job(job_id: str) -> None:
    job = jobs.get(job_id)
    if not job:
        return

    def log(msg: str) -> None:
        jobs.append_log(jobs.get(job_id), msg)

    try:
        # 1) konverze na WAV 16 kHz mono PCM
        # POZOR: jiný název než upload (ten může být taky .wav) - ffmpeg
        # neumí přepsat vstupní soubor sám sebou.
        jobs.set_status(job_id, "converting_audio", 15)
        wav_path = config.UPLOADS_DIR / f"{job_id}.16k.wav"
        ffmpeg_tools.convert_to_wav(job.upload_path, wav_path, log=log)
        duration = ffmpeg_tools.get_audio_duration(wav_path, log=log)
        jobs.update(job_id, wav_path=str(wav_path), duration=duration)
        jobs.set_status(job_id, "ready_for_asr", 30)

        # 2) ASR (parakeet.cpp)
        jobs.set_status(job_id, "transcribing", 45)
        result = asr_engine.transcribe_file(
            str(wav_path), job.language, job_id, duration=duration, log=log,
        )

        # 3) export výstupů
        jobs.set_status(job_id, "exporting", 90)
        meta = {
            "job_id": job_id,
            "filename": job.filename,
            "language": job.language,
            "duration": duration,
            "backend": result.get("backend"),
            "model": result.get("model"),
        }
        paths = exporters.export_all(
            result, config.OUTPUTS_DIR, job_id, job.formats, meta,
        )
        jobs.update(
            job_id,
            text_preview=(result.get("text") or "")[:20000],
            output_txt=paths.get("txt"),
            output_srt=paths.get("srt"),
            output_vtt=paths.get("vtt"),
            output_json=paths.get("json"),
        )
        jobs.set_status(job_id, "done", 100)
        log("HOTOVO.")
    except asr_engine.AsrError as e:
        # Sem spadne i případ "ASR backend není připojen".
        log(f"ASR backend není připojen / chyba ASR: {e}")
        jobs.update(job_id, error=str(e))
        jobs.set_status(job_id, "error")
    except ffmpeg_tools.FfmpegError as e:
        log(f"Chyba konverze audia: {e}")
        jobs.update(job_id, error=str(e))
        jobs.set_status(job_id, "error")
    except Exception as e:   # pojistka - UI nesmí spadnout
        log(f"CHYBA: {e}")
        jobs.update(job_id, error=str(e))
        jobs.set_status(job_id, "error")


# --- API ------------------------------------------------------------------
@app.get("/api/status")
def api_status() -> dict:
    ff = ffmpeg_tools.check_ffmpeg()
    eng = asr_engine.engine_status()
    return {
        "app": "PZ ASR Studio",
        "version": app.version,
        "python": sys.version.split()[0],
        "python_ok": sys.version_info >= (3, 11),
        "platform": platform.platform(),
        "cpu_mode": True,                 # parakeet.cpp = CPU-only cesta
        "ffmpeg": ff,
        "parakeet": {"ok": eng["parakeet_ok"], "exe": eng["parakeet_exe"]},
        "model": {
            "ok": eng["model_ok"],
            "path": eng["model_path"],
            "name": eng["model_name"],
        },
        "languages": config.SUPPORTED_LANGUAGES,
        "output_formats": config.OUTPUT_FORMATS,
        "ready": ff["ok"] and eng["parakeet_ok"] and eng["model_ok"],
    }


@app.post("/api/upload")
async def api_upload(
    file: UploadFile = File(...),
    language: str = Form(config.DEFAULT_LANGUAGE),
    formats: str = Form("txt,srt,vtt,json"),
) -> dict:
    filename = Path(file.filename or "audio").name
    ext = Path(filename).suffix.lower()
    if ext not in config.SUPPORTED_INPUT_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(f"Nepodporovaný formát '{ext}'. Povolené: "
                    f"{', '.join(sorted(config.SUPPORTED_INPUT_EXTENSIONS))}"),
        )
    fmt_list = [f.strip() for f in formats.split(",")
                if f.strip() in config.OUTPUT_FORMATS] or list(config.OUTPUT_FORMATS)

    job = jobs.create(filename, "", language, fmt_list)
    upload_path = config.UPLOADS_DIR / f"{job.id}{ext}"
    with open(upload_path, "wb") as out:
        shutil.copyfileobj(file.file, out)
    jobs.update(job.id, upload_path=str(upload_path))
    jobs.append_log(jobs.get(job.id),
                    f"Nahráno: {filename} -> {upload_path.name}")
    return {"job_id": job.id, "job": jobs.get(job.id).to_dict()}


@app.post("/api/transcribe/{job_id}")
def api_transcribe(job_id: str,
                   req: "TranscribeRequest | None" = Body(default=None)) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job nenalezen.")
    if job.status in ("converting_audio", "transcribing", "exporting"):
        raise HTTPException(409, "Job už běží.")
    if not job.upload_path or not Path(job.upload_path).is_file():
        raise HTTPException(400, "Chybí nahraný soubor pro tento job.")

    updates: dict = {"error": None}
    if req and req.language:
        updates["language"] = req.language
    if req and req.formats:
        fmts = [f for f in req.formats if f in config.OUTPUT_FORMATS]
        if fmts:
            updates["formats"] = fmts
    jobs.update(job_id, **updates)
    jobs.set_status(job_id, "uploaded", 5)

    threading.Thread(target=_process_job, args=(job_id,), daemon=True).start()
    return {"job_id": job_id, "status": "started"}


@app.get("/api/jobs")
def api_jobs() -> dict:
    return {"jobs": jobs.list()}


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job nenalezen.")
    return job.to_dict()


@app.get("/api/jobs/{job_id}/log")
def api_job_log(job_id: str) -> PlainTextResponse:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job nenalezen.")
    return PlainTextResponse(jobs.read_log(job_id))


@app.get("/api/download/{job_id}/{fmt}")
def api_download(job_id: str, fmt: str) -> FileResponse:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job nenalezen.")
    mapping = {
        "txt": job.output_txt, "srt": job.output_srt,
        "vtt": job.output_vtt, "json": job.output_json,
    }
    path = mapping.get(fmt)
    if not path or not Path(path).is_file():
        raise HTTPException(404, f"Výstup '{fmt}' pro tento job neexistuje.")
    media = {
        "txt": "text/plain; charset=utf-8",
        "srt": "application/x-subrip; charset=utf-8",
        "vtt": "text/vtt; charset=utf-8",
        "json": "application/json; charset=utf-8",
    }.get(fmt, "application/octet-stream")
    download_name = f"{Path(job.filename).stem}.{fmt}"
    return FileResponse(path, media_type=media, filename=download_name)


@app.delete("/api/jobs/{job_id}")
def api_delete(job_id: str) -> dict:
    if not jobs.delete(job_id):
        raise HTTPException(404, "Job nenalezen.")
    return {"deleted": job_id}


# --- frontend (mount NAKONEC, ať /api/* má přednost) ----------------------
# StaticFiles s html=True servíruje index.html na "/" a statické soubory.
app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True),
          name="static")
