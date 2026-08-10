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

if [ ! -d "$REPO/.git" ]; then
    echo "📥 2/6 Clonando SDK-Bot (main)..."
    git clone https://github.com/Zer0x25/SDK-Bot.git "$REPO"
else
    echo "📥 2/6 Repo existente en $REPO, actualizando..."
    git -C "$REPO" fetch origin
    git -C "$REPO" pull --ff-only origin main
fi

echo "🐍 3/6 Dependencias del brain (sin google-generativeai: no compila en bionic)..."
cd "$REPO/brain"
pip install -r requirements-termux.txt

echo "🌐 4/6 Dependencias del gateway (Node)..."
cd "$REPO/gateway"
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
fi

echo "🛠 6/6 Registrando servicios en runit..."
SVDIR="$PREFIX/var/service"
mkdir -p "$SVDIR/sdk-brain" "$SVDIR/sdk-gateway"

cat > "$SVDIR/sdk-brain/run" <<EOF
#!/bin/sh
exec 2>&1
cd "$REPO/brain"
export PYTHONPATH="$REPO/brain:\$PYTHONPATH"
exec /data/data/com.termux/files/usr/bin/python main.py
EOF

cat > "$SVDIR/sdk-gateway/run" <<EOF
#!/bin/sh
LOG="$HOME/logs/sdk-gateway.log"
mkdir -p "$HOME/logs"
cd "$REPO/gateway"
export NODE_PATH="$REPO/gateway/node_modules:\$NODE_PATH"
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

echo ""
echo "Verifica con:"
echo "  sv status sdk-brain sdk-gateway"
echo "  tail -f ~/logs/sdk-gateway.log"
echo ""
echo "⚠️  Si es la primera vez, escanea el QR de WhatsApp en el log del gateway."
