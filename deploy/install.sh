#!/usr/bin/env bash
# Instalador de los services de SDK-Bot en systemd (requiere sudo).
# Uso: sudo bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📦 Instalando sdk-bot-brain.service y sdk-bot-gateway.service..."
cp "$SCRIPT_DIR/sdk-bot-brain.service" /etc/systemd/system/
cp "$SCRIPT_DIR/sdk-bot-gateway.service" /etc/systemd/system/
systemctl daemon-reload

echo "🚀 Activando servicios (se iniciarán en el próximo arranque)..."
systemctl enable sdk-bot-brain
systemctl enable sdk-bot-gateway

echo ""
echo "🛑 Deteniendo instancias manuales (si las hay) para liberar los locks..."
# Los procesos manuales bloquean el arranque de systemd (protección de instancia única)
pkill -f "venv/bin/python main.py" || true
pkill -f "node index.js" || true
sleep 3

echo "▶️ Arrancando services..."
systemctl start sdk-bot-brain
sleep 2
systemctl start sdk-bot-gateway

echo ""
echo "✅ Instalado. Verifica con:"
echo "  systemctl status sdk-bot-brain sdk-bot-gateway"
echo "  journalctl -u sdk-bot-gateway -f"
