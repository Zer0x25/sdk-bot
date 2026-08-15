#!/usr/bin/env bash
# Lanzamiento manual de desarrollo. La producción se ejecuta con Docker Compose.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
    printf 'Uso: bash deploy/linux/dev.sh manual <brain|gateway|panel|ambos|todos>\n'
}

if [ "${1:-}" != "manual" ]; then
    usage
    exit 1
fi

TARGET="${2:-todos}"
case "$TARGET" in
    brain)
        cd "$REPO/brain"
        exec env NODE_ENV=development BRAIN_PORT=5100 BRAIN_HOST=0.0.0.0 venv/bin/python main.py
        ;;
    gateway)
        cd "$REPO/gateway"
        exec env NODE_ENV=development SDK_ADMIN_WEB_ENABLED=0 ADMIN_WEB_PORT=5201 STATUS_PORT=5300 \
            BRAIN_API_BASE=http://127.0.0.1:5100 ADMIN_WEB_HOST=0.0.0.0 STATUS_HOST=0.0.0.0 npm start
        ;;
    panel)
        cd "$REPO/gateway/panel"
        exec env NODE_ENV=development ADMIN_WEB_PORT=5201 ADMIN_WEB_HOST=0.0.0.0 \
            GATEWAY_INTERNAL_URL=http://127.0.0.1:5400 node index.js
        ;;
    ambos)
        printf 'Abre dos terminales y ejecuta:\n'
        printf '  NODE_ENV=development bash deploy/linux/dev.sh manual brain\n'
        printf '  NODE_ENV=development bash deploy/linux/dev.sh manual gateway\n'
        ;;
    todos)
        printf 'Abre tres terminales y ejecuta:\n'
        printf '  NODE_ENV=development bash deploy/linux/dev.sh manual brain\n'
        printf '  NODE_ENV=development bash deploy/linux/dev.sh manual gateway\n'
        printf '  NODE_ENV=development bash deploy/linux/dev.sh manual panel\n'
        ;;
    *)
        printf 'Objetivo inválido: %s\n' "$TARGET" >&2
        usage >&2
        exit 1
        ;;
esac
