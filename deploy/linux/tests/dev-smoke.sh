#!/usr/bin/env bash
# Smoke test del lanzamiento manual en dev (deploy/linux/dev.sh).
# Levanta gateway + panel en background, verifica health, y los baja.
# No levanta el brain (requiere uv/venv) para mantener el test liviano en CI;
# el gateway arranca igual sin el brain (solo no responde IA).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$REPO_DIR"

cleanup() { bash deploy/linux/dev.sh down >/dev/null 2>&1 || true; }
trap cleanup EXIT

bash deploy/linux/dev.sh down >/dev/null 2>&1
sleep 1

bash deploy/linux/dev.sh up gateway panel >/dev/null 2>&1

# Espera a que arranquen (hasta 30s)
for i in $(seq 1 30); do
    gw_ok=0; panel_ok=0
    curl -s -m 2 -o /dev/null "http://127.0.0.1:5300/health" 2>/dev/null && gw_ok=1
    curl -s -m 2 -o /dev/null "http://127.0.0.1:5201/" 2>/dev/null && panel_ok=1
    [ "$gw_ok" = 1 ] && [ "$panel_ok" = 1 ] && break
    sleep 1
done

if [ "$gw_ok" != 1 ]; then
    echo "dev smoke: FAIL (gateway :5300 no responde)"; exit 1
fi
if [ "$panel_ok" != 1 ]; then
    echo "dev smoke: FAIL (panel :5201 no responde)"; exit 1
fi

echo "dev smoke: OK (gateway + panel up, down limpio)"
