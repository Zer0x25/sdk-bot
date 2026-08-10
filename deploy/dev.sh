#!/usr/bin/env bash
# Desarrollo local: alternar entre instancias manuales y systemd (producción)
#
# Uso:
#   bash deploy/dev.sh manual <brain|gateway>   # apaga el service systemd y lanza el manual (foreground, Ctrl+C al terminar)
#   bash deploy/dev.sh manual ambos             # apaga ambos services y muestra cómo lanzar en 2 terminales
#   bash deploy/dev.sh reset  <brain|gateway>   # mata las instancias manuales y relanza el service systemd
#   bash deploy/dev.sh reset  ambos             # idem para los dos
#   bash deploy/dev.sh status                   # estado de services y locks
#
# ⚠️  Nunca corras manual y systemd del mismo componente a la vez:
#     el lock de instancia única bloquea al segundo que arranque.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status() {
    echo "=== Services systemd ==="
    systemctl is-active sdk-bot-brain sdk-bot-gateway
    echo ""
    echo "=== Locks ==="
    echo -n "brain:   "; cat "$REPO/brain/.brain.lock" 2>/dev/null || echo "(sin lock)"
    echo -n "gateway: "; cat "$REPO/gateway/.gateway.lock" 2>/dev/null || echo "(sin lock)"
}

case "${1:-}" in
    manual)
        TARGET="${2:-ambos}"
        case "$TARGET" in
            brain|gateway) LIST="$TARGET" ;;
            ambos) LIST="brain gateway" ;;
            *) echo "❌ Objetivo inválido: $TARGET (usa brain, gateway o ambos)"; exit 1 ;;
        esac

        for s in $LIST; do
            echo "🛑 Deteniendo service systemd sdk-bot-$s..."
            sudo systemctl stop "sdk-bot-$s"
        done

        if [ "$LIST" = "brain gateway" ]; then
            echo ""
            echo "▶️  Abre 2 terminales y lanza:"
            echo "    1) BRAIN:   cd $REPO/brain && venv/bin/python main.py"
            echo "    2) GATEWAY: cd $REPO/gateway && npm start"
            echo ""
            echo "Para volver a producción: bash deploy/dev.sh reset"
        elif [ "$TARGET" = "brain" ]; then
            echo "▶️  Lanzando BRAIN manual en esta terminal (Ctrl+C para salir)..."
            cd "$REPO/brain" && exec venv/bin/python main.py
        else
            echo "▶️  Lanzando GATEWAY manual en esta terminal (Ctrl+C para salir)..."
            cd "$REPO/gateway" && exec npm start
        fi
        ;;

    reset)
        TARGET="${2:-ambos}"
        case "$TARGET" in
            brain) PATTERNS=("venv/bin/python main.py") ;;
            gateway) PATTERNS=("node index.js") ;;
            ambos) PATTERNS=("venv/bin/python main.py" "node index.js") ;;
            *) echo "❌ Objetivo inválido: $TARGET (usa brain, gateway o ambos)"; exit 1 ;;
        esac

        echo "🔫 Matando instancias manuales (y las de systemd si quedaron)..."
        for p in "${PATTERNS[@]}"; do
            pkill -f "$p" 2>/dev/null || true
        done
        sleep 3

        case "$TARGET" in
            brain) SERVICES="sdk-bot-brain" ;;
            gateway) SERVICES="sdk-bot-gateway" ;;
            *) SERVICES="sdk-bot-brain sdk-bot-gateway" ;;
        esac
        for s in $SERVICES; do
            echo "▶️  Levantando service systemd $s..."
            sudo systemctl restart "$s"
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
