#!/usr/bin/env bash
# Alternativa legacy: instala los services de SDK-Bot en systemd --user.
# La producción documentada usa deploy/docker/compose.yml.
# No requiere sudo: todo el homelab corre en systemd --user + linger de zrx1.
# Uso: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$USER_UNIT_DIR"

echo "📦 Instalando brain, gateway y panel (--user)..."
cp "$SCRIPT_DIR/sdk-bot-brain.service"    "$USER_UNIT_DIR/"
cp "$SCRIPT_DIR/sdk-bot-gateway.service" "$USER_UNIT_DIR/"
cp "$SCRIPT_DIR/sdk-bot-panel.service"   "$USER_UNIT_DIR/"

systemctl --user daemon-reload

echo "🚀 Activando servicios (se iniciarán en el próximo arranque del usuario)..."
systemctl --user enable sdk-bot-brain
systemctl --user enable sdk-bot-gateway
systemctl --user enable sdk-bot-panel

echo ""
echo "🛑 Deteniendo instancias manuales (si las hay) para liberar los locks..."
# Los procesos manuales bloquean el arranque de systemd (protección de instancia única).
# Primero detenemos solo nuestras units y luego buscamos procesos manuales por cwd.
# No usar `pkill -f node index.js`: también puede matar servicios Node ajenos.
systemctl --user stop sdk-bot-panel sdk-bot-gateway sdk-bot-brain 2>/dev/null || true

for pid in $(pgrep -u "${UID}" -f '(^|/)node index\.js$' || true); do
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    case "$cwd" in
        "$SCRIPT_DIR/../../gateway"|"$SCRIPT_DIR/../../gateway/panel")
            kill "$pid" 2>/dev/null || true
            ;;
    esac
done

for pid in $(pgrep -u "${UID}" -f '(^|/)venv/bin/python main\.py$' || true); do
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    if [ "$cwd" = "$SCRIPT_DIR/../../brain" ]; then
        kill "$pid" 2>/dev/null || true
    fi
done
sleep 3

echo "▶️ Arrancando services..."
systemctl --user start sdk-bot-brain
sleep 2
systemctl --user start sdk-bot-gateway
sleep 1
systemctl --user start sdk-bot-panel

echo ""
echo "✅ Instalado. Verifica con:"
echo "  systemctl --user status sdk-bot-brain sdk-bot-gateway sdk-bot-panel"
echo "  journalctl --user -u sdk-bot-gateway -f"
