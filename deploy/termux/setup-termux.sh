#!/usr/bin/env bash
# setup-termux.sh — Bootstrap completo de SDK-Bot en Termux (Android).
# Idempotente: puedes ejecutarlo cuantas veces quieras.
#
# Uso: bash setup-termux.sh   (desde ~/SDK-Bot, tras clonar main)
#   o directamente: bash <(curl -fsSL https://raw.githubusercontent.com/Zer0x25/SDK-Bot/main/deploy/termux/setup-termux.sh)
set -euo pipefail

REPO="${SDK_BOT_REPO:-$HOME/SDK-Bot}"

echo "📦 1/6 Actualizando paquetes base de Termux..."
pkg update -y && pkg upgrade -y
pkg install -y python nodejs-lts runit git termux-tools

# termux-wake-lock mantiene vivo el proceso (evita que Android duerma el bot)
termux-wake-lock || true

# 🔐 Secretos (keys + sesión de WhatsApp) viven FUERA del repo en ~/.sdk-bot-secrets
# para que sobrevivan incluso a un re-clon. El repo NUNCA guarda estos archivos.
BACKUP_DIR="$HOME/.sdk-bot-secrets"

if [ ! -d "$REPO/.git" ]; then
    echo "📥 2/6 Clonando SDK-Bot (main)..."
    git clone https://github.com/Zer0x25/SDK-Bot.git "$REPO"
else
    echo "📥 2/6 Repo existente en $REPO, actualizando..."
    git -C "$REPO" fetch origin
    git -C "$REPO" pull --ff-only origin main
fi

echo "🗄 Restaurando secretos desde $BACKUP_DIR (si existen)..."
if [ -d "$BACKUP_DIR" ]; then
    [ -f "$BACKUP_DIR/.env" ] && cp -f "$BACKUP_DIR/.env" "$REPO/brain/.env" && echo "    ✅ brain/.env restaurado (tus keys)"
    [ -d "$BACKUP_DIR/auth_info_baileys" ] && cp -rf "$BACKUP_DIR/auth_info_baileys" "$REPO/gateway/" && echo "    ✅ Sesión de WhatsApp restaurada (no hace falta re-vincular)"
else
    mkdir -p "$BACKUP_DIR"
    echo "    (backup vacío en $BACKUP_DIR — la primera vez hay que pegar keys y escanear el QR)"
fi

echo "🐍 3/6 Dependencias del brain (sin google-generativeai: no compila en bionic)..."
cd "$REPO/brain"
pip install -r requirements-termux.txt

echo "🌐 4/6 Dependencias del gateway (Node)..."
cd "$REPO/apps/gateway"
npm install

if [ ! -f "$REPO/brain/.env" ]; then
    echo "🔑 5/6 Creando brain/.env (PÉGALE TUS KEYS)..."
    cat > "$REPO/brain/.env" <<'EOF'
OPENROUTER_API_KEY=sk-or-REEMPLAZA
GROQ_API_KEY=gsk-REEMPLAZA
# GEMINI_API_KEY=...   # opcional: requiere google-generativeai (no disponible en Termux)
EOF
    chmod 600 "$REPO/brain/.env"
    echo "    ⚠️  Edita $REPO/brain/.env con tus keys reales antes de arrancar."
else
    echo "🔑 5/6 brain/.env EXISTE — se mantiene tal cual (nunca se sobreescribe)."
fi

echo "🛠 6/6 Registrando servicios en runit..."
SVDIR="$PREFIX/var/service"
mkdir -p "$SVDIR/sdk-brain" "$SVDIR/sdk-gateway"

cat > "$SVDIR/sdk-brain/run" <<EOF
#!/bin/sh
exec 2>&1
cd "$REPO/brain"
export PYTHONPATH="$REPO/brain:\$PYTHONPATH"
export BRAIN_PORT=${BRAIN_PORT:-5100}
export BRAIN_HOST=${BRAIN_HOST:-0.0.0.0}
exec /data/data/com.termux/files/usr/bin/python main.py
EOF

cat > "$SVDIR/sdk-gateway/run" <<EOF
#!/bin/sh
LOG="$HOME/logs/sdk-gateway.log"
mkdir -p "$HOME/logs"
cd "$REPO/apps/gateway"
export NODE_PATH="$REPO/apps/gateway/node_modules:\$NODE_PATH"
export STATUS_PORT=${STATUS_PORT:-5300}
export BRAIN_API_BASE=${BRAIN_API_BASE:-http://127.0.0.1:5100}
export INTERNAL_BUS_PORT=${INTERNAL_BUS_PORT:-5400}
exec node index.js 2>&1 | awk '{ print strftime("%Y-%m-%d %H:%M:%S"), \$0; fflush() }' >> "\$LOG"
EOF

chmod +x "$SVDIR/sdk-brain/run" "$SVDIR/sdk-gateway/run"

# Arranque automático tras reiniciar el celular (requiere APK Termux:Boot)
if [ ! -f "$HOME/.termux/boot/start-services.sh" ]; then
    mkdir -p "$HOME/.termux/boot"
    cat > "$HOME/.termux/boot/start-services.sh" <<'EOF'
#!/bin/sh
termux-wake-lock
runsvdir -P "$PREFIX/var/service" &
EOF
    chmod +x "$HOME/.termux/boot/start-services.sh"
fi

echo ""
echo "✅ Listo. Arrancando servicios..."
sv up sdk-brain 2>/dev/null || runsvdir -P "$SVDIR" &
sleep 2
sv up sdk-gateway 2>/dev/null || true

# 🗄 Guardar copia de seguridad SIEMPRE actualizada de los secretos
echo ""
echo "🗄 Actualizando backup de secretos en $BACKUP_DIR..."
[ -f "$REPO/brain/.env" ] && cp -f "$REPO/brain/.env" "$BACKUP_DIR/.env"
[ -d "$REPO/gateway/auth_info_baileys" ] && rm -rf "$BACKUP_DIR/auth_info_baileys" && cp -r "$REPO/gateway/auth_info_baileys" "$BACKUP_DIR/"

echo ""
echo "Verifica con:"
echo "  sv status sdk-brain sdk-gateway"
echo "  tail -f ~/logs/sdk-gateway.log"
echo ""
echo "⚠️  Si es la primera vez, escanea el QR de WhatsApp en el log del gateway."
echo ""
echo "📌 Para actualizaciones futuras NO re-corras este script: usa"
echo "    bash $REPO/deploy/termux/update-termux.sh   (pull + restart, sin tocar keys ni sesión)"
