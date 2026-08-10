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
echo "✅ Listo. Ahora revisa (y ajusta si es necesario) los paths en:"
echo "   /etc/systemd/system/sdk-bot-brain.service"
echo "   /etc/systemd/system/sdk-bot-gateway.service"
echo ""
echo "Comandos útiles:"
echo "  systemctl start sdk-bot-brain    # arrancar ahora"
echo "  systemctl start sdk-bot-gateway"
echo "  systemctl status sdk-bot-gateway # ver estado"
echo "  journalctl -u sdk-bot-gateway -f # ver logs del gateway"
echo ""
echo "⚠️ IMPORTANTE: antes de activar systemd, detén las instancias manuales:"
echo "  cd brain    && python main.py --restart   # detiene la manual"
echo "  cd gateway  && npm start -- --restart     # detiene la manual"
echo "  (el --restart de systemd NO aplica; usa systemctl start/stop)"
