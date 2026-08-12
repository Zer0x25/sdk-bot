#!/usr/bin/env bash
# Instalador de los services de SDK-Bot en systemd --user (estándar homelab).
# No requiere sudo: todo el homelab corre en systemd --user + linger de zrx1.
# Uso: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$USER_UNIT_DIR"

echo "📦 Instalando sdk-bot-brain.service y sdk-bot-gateway.service (--user)..."
cp "$SCRIPT_DIR/sdk-bot-brain.service"    "$USER_UNIT_DIR/"
cp "$SCRIPT_DIR/sdk-bot-gateway.service" "$USER_UNIT_DIR/"

systemctl --user daemon-reload

echo "🚀 Activando servicios (se iniciarán en el próximo arranque del usuario)..."
systemctl --user enable sdk-bot-brain
systemctl --user enable sdk-bot-gateway

echo ""
echo "🛑 Deteniendo instancias manuales (si las hay) para liberar los locks..."
# Los procesos manuales bloquean el arranque de systemd (protección de instancia única)
pkill -f "venv/bin/python main.py" || true
pkill -f "node index.js" || true
sleep 3

echo "▶️ Arrancando services..."
systemctl --user start sdk-bot-brain
sleep 2
systemctl --user start sdk-bot-gateway

echo ""
echo "✅ Instalado. Verifica con:"
echo "  systemctl --user status sdk-bot-brain sdk-bot-gateway"
echo "  journalctl --user -u sdk-bot-gateway -f"
