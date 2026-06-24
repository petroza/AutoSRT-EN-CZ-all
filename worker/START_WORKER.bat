@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
  echo [CHYBA] Chybi virtualni prostredi .venv - spust nejdriv INSTALL.bat
  pause
  exit /b 1
)
call ".venv\Scripts\activate.bat"

REM zajisti knihovnu requests pro workera
python -c "import requests" 2>nul || pip install requests --quiet

echo Spoustim PZ Titulkovac worker (Ctrl+C ukonci)...
python worker.py
echo.
echo Worker skoncil.
pause
