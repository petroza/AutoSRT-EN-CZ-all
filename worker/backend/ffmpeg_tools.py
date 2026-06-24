"""
Práce s ffmpeg / ffprobe:
  - ověření dostupnosti
  - konverze libovolného audia/videa na WAV 16 kHz mono PCM s16le
  - zjištění délky audia
  - logování chyb
"""
from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path
from typing import Callable, Optional, Union

from . import config

LogFn = Optional[Callable[[str], None]]

# Na Windows skryj okno konzole spouštěného procesu (CREATE_NO_WINDOW).
_CREATE_NO_WINDOW = 0x08000000


def _popen_kwargs() -> dict:
    kwargs: dict = {}
    if hasattr(subprocess, "STARTUPINFO"):   # tj. běžíme na Windows
        kwargs["creationflags"] = _CREATE_NO_WINDOW
    return kwargs


def _log(log: LogFn, msg: str) -> None:
    if log:
        log(msg)


class FfmpegError(RuntimeError):
    pass


def check_ffmpeg() -> dict:
    """Vrátí stav ffmpeg / ffprobe (pro diagnostiku)."""
    ffmpeg = config.find_ffmpeg()
    ffprobe = config.find_ffprobe()
    version = None
    if ffmpeg:
        try:
            out = subprocess.run(
                [str(ffmpeg), "-version"],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=15, **_popen_kwargs(),
            )
            if out.stdout:
                version = out.stdout.splitlines()[0]
        except Exception:
            version = None
    return {
        "ok": ffmpeg is not None,
        "ffmpeg": str(ffmpeg) if ffmpeg else None,
        "ffprobe": str(ffprobe) if ffprobe else None,
        "version": version,
    }


def get_audio_duration(path: Union[str, Path], log: LogFn = None) -> float:
    """Délka audia v sekundách. Nejdřív ffprobe, fallback wave (jen .wav)."""
    path = Path(path)
    ffprobe = config.find_ffprobe()
    if ffprobe:
        try:
            out = subprocess.run(
                [str(ffprobe), "-v", "quiet", "-print_format", "json",
                 "-show_format", str(path)],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=30, **_popen_kwargs(),
            )
            data = json.loads(out.stdout or "{}")
            dur = data.get("format", {}).get("duration")
            if dur is not None:
                return float(dur)
        except Exception as e:
            _log(log, f"ffprobe nezjistil délku, zkouším wave: {e}")
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                frames = w.getnframes()
                rate = w.getframerate()
                if rate:
                    return frames / float(rate)
        except Exception as e:
            _log(log, f"wave délku nezjistil: {e}")
    return 0.0


def convert_to_wav(input_path: Union[str, Path], output_wav: Union[str, Path],
                   log: LogFn = None) -> Path:
    """
    Převede libovolné podporované audio/video na WAV 16 kHz mono PCM s16le.
    Vrací cestu k výslednému WAV. Při chybě vyhodí FfmpegError.
    """
    ffmpeg = config.find_ffmpeg()
    if not ffmpeg:
        raise FfmpegError(
            "ffmpeg nebyl nalezen. Dej ffmpeg.exe (a ffprobe.exe) do "
            "tools/ffmpeg/ nebo do systémové PATH. Viz README."
        )
    input_path = Path(input_path)
    output_wav = Path(output_wav)
    output_wav.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        str(ffmpeg), "-y",
        "-i", str(input_path),
        "-vn",                                  # zahodit video stopu
        "-ac", str(config.TARGET_CHANNELS),     # mono
        "-ar", str(config.TARGET_SAMPLE_RATE),  # 16 kHz
        "-acodec", config.TARGET_CODEC,         # PCM s16le
        "-f", "wav",
        str(output_wav),
    ]
    _log(log, "FFMPEG: " + " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **_popen_kwargs())
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-15:]
        _log(log, "FFMPEG chyba:\n" + "\n".join(tail))
        raise FfmpegError(
            f"ffmpeg konverze selhala (kód {proc.returncode}). Detail v logu jobu."
        )
    if not output_wav.is_file() or output_wav.stat().st_size == 0:
        raise FfmpegError("ffmpeg nevytvořil výstupní WAV (prázdný soubor).")
    _log(log, f"WAV hotov: {output_wav.name} ({output_wav.stat().st_size} B)")
    return output_wav
