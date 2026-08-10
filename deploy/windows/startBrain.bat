@echo off
REM SDK-Bot — Brain (FastAPI :8000) en Windows
REM Requisitos: Python 3.12+ instalado (con "Add to PATH")
cd /d %~dp0..\..\brain
if not exist venv\Scripts\python.exe (
    echo [1/2] Creando venv...
    python -m venv venv
    venv\Scripts\pip install -r requirements.txt
)
echo [2/2] Arrancando Brain... (Ctrl+C para detener)
venv\Scripts\python main.py
