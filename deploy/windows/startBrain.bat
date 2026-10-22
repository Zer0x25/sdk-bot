@echo off
REM SDK-Bot — Brain (FastAPI :5100) en Windows
REM Requisitos: Python 3.12+ instalado (con "Add to PATH")
set "REPO_ROOT=%~dp0..\.."
set "BRAIN_STATE=%REPO_ROOT%\brain"
set "BRAIN_APP=%REPO_ROOT%\apps\brain"
set "SDK_BRAIN_STATE_DIR=%BRAIN_STATE%"
cd /d "%BRAIN_STATE%"
if not exist venv\Scripts\python.exe (
    echo [1/2] Creando venv...
    python -m venv venv
    venv\Scripts\pip install -r "%BRAIN_APP%\requirements.txt"
)
echo [2/2] Arrancando Brain... (Ctrl+C para detener)
cd /d "%BRAIN_APP%"
"%BRAIN_STATE%\venv\Scripts\python.exe" main.py
