@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==================================================
echo   PZ ASR Studio - DIAGNOSTIKA
echo ==================================================

REM zajisti slozky
for %%D in (uploads outputs jobs logs models tools\parakeet tools\ffmpeg) do (
  if not exist "%%D" mkdir "%%D"
)

REM 1) Python
where python >nul 2>nul
if errorlevel 1 (
  echo [CHYBA] Python neni v PATH
) else (
  for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PYVER=%%v
  echo [OK] Python !PYVER!
)

REM 2) virtualenv
if exist ".venv\Scripts\python.exe" (
  echo [OK] virtualenv .venv
) else (
  echo [!]  .venv chybi - spust INSTALL.bat
)

REM 3) ffmpeg
set FFOK=0
where ffmpeg >nul 2>nul && set FFOK=1
if "!FFOK!"=="0" if exist "tools\ffmpeg\ffmpeg.exe" set FFOK=1
if "!FFOK!"=="1" (echo [OK] ffmpeg) else (echo [!]  ffmpeg nenalezen)

REM 4) parakeet.cpp
dir /b /s "tools\parakeet\parakeet-cli.exe" >nul 2>nul
if errorlevel 1 (
  where parakeet-cli >nul 2>nul && (echo [OK] parakeet-cli v PATH) || (echo [!]  parakeet-cli nenalezen)
) else (
  echo [OK] parakeet-cli v tools\parakeet
)

REM 5) model
dir /b "models\*.gguf" >nul 2>nul
if errorlevel 1 (echo [!]  zadny .gguf v models\) else (echo [OK] model .gguf v models\)

REM 6) zapis do slozek
for %%D in (uploads outputs jobs logs) do (
  >"%%D\.write_test" echo test 2>nul
  if exist "%%D\.write_test" (
    del "%%D\.write_test" >nul 2>nul
    echo [OK] zapis do %%D
  ) else (
    echo [CHYBA] nelze zapsat do %%D
  )
)

REM 7) port 8787
netstat -ano | findstr ":8787" >nul 2>nul
if errorlevel 1 (echo [OK] port 8787 je volny) else (echo [!]  port 8787 je OBSAZENY)

REM 8) Ollama (automaticka oprava cizich slov/znacek)
curl -s -m 5 http://127.0.0.1:11434/api/tags >nul 2>nul
if errorlevel 1 (echo [!]  Ollama nebezi - LLM oprava cizich slov se preskoci ^(fallback na puvodni text^)) else (echo [OK] Ollama bezi - LLM oprava cizich slov aktivni)

echo ==================================================
echo   Konec diagnostiky
echo ==================================================
pause
