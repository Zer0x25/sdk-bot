@echo off
REM SDK-Bot — Gateway (WhatsApp/Baileys) en Windows
REM Requisitos: Node.js 22.13+ (el gateway usa node_modules del repo)
cd /d %~dp0..\..\apps\gateway
if not exist node_modules\@whiskeysockets\baileys goto install_deps
if not exist node_modules\@sdk-bot\contracts\index.js goto install_deps
fc /b ..\..\packages\contracts\schema.json node_modules\@sdk-bot\contracts\schema.json >nul 2>&1
if errorlevel 1 goto install_deps
fc /b ..\..\packages\contracts\index.js node_modules\@sdk-bot\contracts\index.js >nul 2>&1
if errorlevel 1 goto install_deps
goto start_gateway
:install_deps
echo [1/2] Instalando dependencias...
call npm ci
if errorlevel 1 exit /b 1
:start_gateway
echo [2/2] Arrancando Gateway... (Ctrl+C para detener)
node index.js
