@echo off
REM SDK-Bot — Gateway (WhatsApp/Baileys) en Windows
REM Requisitos: Node.js 20+ (el gateway usa node_modules del repo)
cd /d %~dp0..\..\gateway
if not exist node_modules\@whiskeysockets\baileys (
    echo [1/2] Instalando dependencias...
    call npm install
)
echo [2/2] Arrancando Gateway... (Ctrl+C para detener)
node index.js
