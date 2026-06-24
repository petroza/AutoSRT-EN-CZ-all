"""
Správa jobů. Žádná databáze - každý job je jeden JSON soubor v jobs/{id}.json.
Vlákno-bezpečné přes RLock (pipeline běží v samostatném vlákně).
"""
from __future__ import annotations

import json
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from . import config

VALID_STATUSES = [
    "uploaded", "converting_audio", "ready_for_asr",
    "transcribing", "exporting", "done", "error",
]


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


@dataclass
class Job:
    id: str
    filename: str
    upload_path: str
    wav_path: Optional[str] = None
    status: str = "uploaded"
    progress: int = 0
    language: str = config.DEFAULT_LANGUAGE
    formats: List[str] = field(default_factory=lambda: list(config.OUTPUT_FORMATS))
    created_at: str = field(default_factory=_now)
    finished_at: Optional[str] = None
    error: Optional[str] = None
    duration: float = 0.0
    text_preview: str = ""
    output_txt: Optional[str] = None
    output_srt: Optional[str] = None
    output_vtt: Optional[str] = None
    output_json: Optional[str] = None
    log_path: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


class JobManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        config.ensure_dirs()

    def _job_file(self, job_id: str) -> Path:
        return config.JOBS_DIR / f"{job_id}.json"

    def create(self, filename: str, upload_path: str,
               language: str, formats: List[str]) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(
            id=job_id,
            filename=filename,
            upload_path=upload_path,
            language=language or config.DEFAULT_LANGUAGE,
            formats=formats or list(config.OUTPUT_FORMATS),
            log_path=str(config.LOGS_DIR / f"{job_id}.log"),
        )
        self.save(job)
        return job

    def save(self, job: Job) -> None:
        with self._lock:
            self._job_file(job.id).write_text(
                json.dumps(job.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def get(self, job_id: str) -> Optional[Job]:
        path = self._job_file(job_id)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return Job(**{k: v for k, v in data.items()
                          if k in Job.__dataclass_fields__})
        except Exception:
            return None

    def update(self, job_id: str, **fields) -> Optional[Job]:
        with self._lock:
            job = self.get(job_id)
            if not job:
                return None
            for k, v in fields.items():
                if hasattr(job, k):
                    setattr(job, k, v)
            self.save(job)
            return job

    def set_status(self, job_id: str, status: str,
                   progress: Optional[int] = None) -> Optional[Job]:
        fields: dict = {"status": status}
        if progress is not None:
            fields["progress"] = progress
        if status in ("done", "error"):
            fields["finished_at"] = _now()
        return self.update(job_id, **fields)

    def list(self) -> List[dict]:
        with self._lock:
            jobs: List[dict] = []
            for f in config.JOBS_DIR.glob("*.json"):
                try:
                    jobs.append(json.loads(f.read_text(encoding="utf-8")))
                except Exception:
                    continue
        jobs.sort(key=lambda j: j.get("created_at", ""), reverse=True)
        return jobs

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self.get(job_id)
            if not job:
                return False
            for p in (job.upload_path, job.wav_path, job.log_path,
                      job.output_txt, job.output_srt, job.output_vtt,
                      job.output_json):
                if p:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except Exception:
                        pass
            try:
                self._job_file(job_id).unlink(missing_ok=True)
            except Exception:
                pass
            return True

    # --- logy ------------------------------------------------------------
    def append_log(self, job: Optional[Job], msg: str) -> None:
        if not job or not job.log_path:
            return
        line = f"[{_now()}] {msg}\n"
        try:
            with open(job.log_path, "a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception:
            pass

    def read_log(self, job_id: str) -> str:
        job = self.get(job_id)
        if not job or not job.log_path:
            return ""
        p = Path(job.log_path)
        if not p.is_file():
            return ""
        try:
            return p.read_text(encoding="utf-8")
        except Exception:
            return ""
