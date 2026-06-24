@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==================================================
echo   PZ ASR Studio - INSTALACE
echo ==================================================
echo.

REM vytvor pracovni slozky
for %%D in (uploads outputs jobs logs models tools\parakeet tools\ffmpeg) do (
  if not exist "%%D" mkdir "%%D"
)

REM 1) Python
where python >nul 2>nul
if errorlevel 1 (
  echo [CHYBA] Python nebyl nalezen v PATH.
  echo         Nainstaluj Python 3.11+ z https://www.python.org/downloads/
  echo         a pri instalaci zaskrtni "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo [OK] Python !PYVER!

REM 2) virtualni prostredi
if not exist ".venv\Scripts\python.exe" (
  echo [..] Vytvarim virtualni prostredi .venv ...
  python -m venv .venv
  if errorlevel 1 (
    echo [CHYBA] Nepodarilo se vytvorit .venv
    pause
    exit /b 1
  )
)
call ".venv\Scripts\activate.bat"
echo [OK] virtualni prostredi .venv

REM 3) zavislosti
echo [..] Aktualizuji pip a instaluji zavislosti...
python -m pip install --upgrade pip >nul 2>nul
pip install -r requirements.txt
if errorlevel 1 (
  echo [CHYBA] Instalace zavislosti selhala (potrebujes internet pro pip).
  pause
  exit /b 1
)
echo [OK] Zavislosti nainstalovany.
echo.

echo --------------------------------------------------
echo   KONTROLA EXTERNICH NASTROJU
echo --------------------------------------------------

REM 4) ffmpeg
set FFOK=0
where ffmpeg >nul 2>nul && set FFOK=1
if "!FFOK!"=="0" if exist "tools\ffmpeg\ffmpeg.exe" set FFOK=1
if "!FFOK!"=="1" (
  echo [OK] ffmpeg nalezen
) else (
  echo [!]  ffmpeg NENALEZEN
  echo      Stahni "release essentials" z https://www.gyan.dev/ffmpeg/builds/
  echo      a rozbal ffmpeg.exe + ffprobe.exe do:
  echo      %CD%\tools\ffmpeg\
)

REM 5) parakeet.cpp
dir /b /s "tools\parakeet\parakeet-cli.exe" >nul 2>nul
if errorlevel 1 (
  where parakeet-cli >nul 2>nul
  if errorlevel 1 (
    echo [!]  parakeet-cli.exe NENALEZEN
    echo      Stahni Windows build (CPU) z:
    echo      https://github.com/mudler/parakeet.cpp/releases
    echo      a dej parakeet-cli.exe do:
    echo      %CD%\tools\parakeet\
  ) else (
    echo [OK] parakeet-cli v PATH
  )
) else (
  echo [OK] parakeet-cli nalezen v tools\parakeet
)

REM 6) model
dir /b "models\*.gguf" >nul 2>nul
if errorlevel 1 (
  echo [!]  Zadny .gguf model ve slozce models\
  echo      Stahni doporuceny model (cestina/EN/UA) z:
  echo      https://huggingface.co/mudler/parakeet-cpp-gguf
  echo      napr. nemotron-3.5-asr-streaming-0.6b-q5_k.gguf
  echo      a dej ho do:
  echo      %CD%\models\
) else (
  echo [OK] model .gguf nalezen v models\
)

echo.
echo ==================================================
echo   Hotovo. Aplikaci spustis pres  START.bat
echo ==================================================
pause
