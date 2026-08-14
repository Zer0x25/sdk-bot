#!/usr/bin/env bash
# Desarrollo local: alternar entre instancias manuales y systemd --user (estándar homelab)
#
# Uso:
#   bash deploy/dev.sh manual <brain|gateway>   # apaga el service --user y lanza el manual (foreground, Ctrl+C al terminar)
#   bash deploy/dev.sh manual ambos             # apaga ambos services y muestra cómo lanzar en 2 terminales
#   bash deploy/dev.sh reset  <brain|gateway>   # mata las instancias manuales y relanza el service --user
#   bash deploy/dev.sh reset  ambos             # idem para los dos
#   bash deploy/dev.sh status                   # estado de services y locks
#
# ⚠️  Nunca corras manual y systemd del mismo componente a la vez:
#     el lock de instancia única bloquea al segundo que arranque.
# ⚠️  Todo en systemd --user (sin sudo). El linger de zrx1 mantiene los units vivos
#     aunque no haya sesión interactiva.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status() {
    echo "=== Services systemd --user ==="
    systemctl --user is-active sdk-bot-brain sdk-bot-gateway
    echo ""
    echo "=== Locks ==="
    echo -n "brain:   "; cat "$REPO/brain/.brain.lock" 2>/dev/null || echo "(sin lock)"
    echo -n "gateway: "; cat "$REPO/gateway/.gateway.lock" 2>/dev/null || echo "(sin lock)"
}

case "${1:-}" in
    manual)
        TARGET="${2:-todos}"
        case "$TARGET" in
            brain|gateway|panel) LIST="$TARGET" ;;
            ambos) LIST="brain gateway" ;;
            todos) LIST="brain gateway panel" ;;
            *) echo "❌ Objetivo inválido: $TARGET (usa brain, gateway, panel, ambos o todos)"; exit 1 ;;
        esac

        for s in $LIST; do
            echo "🛑 Deteniendo service --user sdk-bot-$s..."
            systemctl --user stop "sdk-bot-$s"
        done

        if [ "$LIST" = "brain gateway" ]; then
            echo ""
            echo "▶️  Abre 2 terminales y lanza:"
            echo "    1) BRAIN:   cd $REPO/brain && venv/bin/python main.py"
            echo "    2) GATEWAY: cd $REPO/gateway && npm start"
            echo ""
            echo "Para volver a producción: bash deploy/dev.sh reset"
        elif [ "$LIST" = "brain gateway panel" ]; then
            echo ""
            echo "▶️  Abre 3 terminales y lanza:"
            echo "    1) BRAIN:   cd $REPO/brain && venv/bin/python main.py"
            echo "    2) GATEWAY: cd $REPO/gateway && npm start"
            echo "    3) PANEL:   cd $REPO/gateway/panel && node index.js"
            echo ""
            echo "Para volver a producción: bash deploy/dev.sh reset"
        elif [ "$TARGET" = "brain" ]; then
            echo "▶️  Lanzando BRAIN manual en esta terminal (Ctrl+C para salir)..."
            cd "$REPO/brain" && exec venv/bin/python main.py
        elif [ "$TARGET" = "panel" ]; then
            echo "▶️  Lanzando PANEL manual en esta terminal (Ctrl+C para salir)..."
            export ADMIN_WEB_PORT=5201 ADMIN_WEB_HOST=0.0.0.0 GATEWAY_INTERNAL_URL=http://127.0.0.1:5400
            cd "$REPO/gateway/panel" && exec node index.js
        else
            echo "▶️  Lanzando GATEWAY manual en esta terminal (Ctrl+C para salir)..."
            # Replicar las env del systemd --user para que el panel web y los
            # puertos se comporten igual que en producción (el bot solo monta
            # el panel si SDK_ADMIN_WEB_ENABLED=1; sin esto el manual no lo sube).
            export LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=America/Santiago
            export SDK_ADMIN_WEB_ENABLED=1 ADMIN_WEB_PORT=5201 STATUS_PORT=5300
            export BRAIN_API_BASE=http://127.0.0.1:5100 ADMIN_WEB_HOST=0.0.0.0 STATUS_HOST=0.0.0.0
            cd "$REPO/gateway" && exec npm start
        fi
        ;;

    reset)
        TARGET="${2:-todos}"
        case "$TARGET" in
            brain) PATTERNS=("venv/bin/python main.py") ;;
            gateway) PATTERNS=("node index.js") ;;
            panel) PATTERNS=("gateway/panel/index.js" "panel/index.js") ;;
            ambos) PATTERNS=("venv/bin/python main.py" "node index.js") ;;
            todos) PATTERNS=("venv/bin/python main.py" "node index.js" "gateway/panel/index.js" "panel/index.js") ;;
            *) echo "❌ Objetivo inválido: $TARGET (usa brain, gateway, panel, ambos o todos)"; exit 1 ;;
        esac

        echo "🔫 Matando instancias manuales (y las de systemd si quedaron)..."
        for p in "${PATTERNS[@]}"; do
            pkill -f "$p" 2>/dev/null || true
        done
        sleep 3

        case "$TARGET" in
            brain) SERVICES="sdk-bot-brain" ;;
            gateway) SERVICES="sdk-bot-gateway" ;;
            panel) SERVICES="sdk-bot-panel" ;;
            *) SERVICES="sdk-bot-brain sdk-bot-gateway sdk-bot-panel" ;;
        esac
        for s in $SERVICES; do
            echo "▶️  Levantando service --user $s..."
            systemctl --user restart "$s"
        done
        echo "✅ Verifica: bash deploy/dev.sh status"
        ;;

    status)
        status
        ;;

    *)
        echo "Uso: bash deploy/dev.sh <manual|reset|status> [brain|gateway|ambos]"
        exit 1
        ;;
esac
