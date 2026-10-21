#!/usr/bin/env bash
# Lanzamiento de desarrollo. La producción se ejecuta con Docker Compose.
#
# Uso:
#   bash deploy/linux/dev.sh up [brain|gateway|panel|all]   # lanza en background (idempotente)
#   bash deploy/linux/dev.sh down                            # mata todo lo lanzado por up
#   bash deploy/linux/dev.sh status                          # health de los 3 puertos
#   bash deploy/linux/dev.sh manual <brain|gateway|panel|ambos|todos>  # imprime/launch 1 (legacy)
#
# Notas:
#   - Los procesos corren en background; logs en /tmp/sdk-bot-{brain,gateway,panel}.log
#   - NODE_ENV=development SIEMPRE (el host puede tener NODE_ENV=production global,
#     y con eso `npm ci` omite devDeps y rompe lint/typecheck).
#   - El venv del brain se crea con `uv` (python3 -m venv falla por PEP 668 en este host).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_DIR="/tmp/sdk-bot-dev"
mkdir -p "$PID_DIR"

BRAIN_PORT="${BRAIN_PORT:-5100}"
ADMIN_WEB_PORT="${ADMIN_WEB_PORT:-5201}"
STATUS_PORT="${STATUS_PORT:-5300}"
BRAIN_HOST="${BRAIN_HOST:-0.0.0.0}"
ADMIN_WEB_HOST="${ADMIN_WEB_HOST:-0.0.0.0}"
STATUS_HOST="${STATUS_HOST:-0.0.0.0}"

log() { printf '%s\n' "$*"; }

# Gateway and panel must share the v1 signing key. The panel loads this file
# itself; copy only this variable into the launcher environment for Gateway.
# Do not source the .env file as shell code.
load_panel_gateway_secret() {
    [ "${SDK_PANEL_GATEWAY_SECRET+x}" = x ] && return 0
    local dotenv="$REPO/gateway/panel/.env" line value
    [ -f "$dotenv" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*SDK_PANEL_GATEWAY_SECRET[[:space:]]*=(.*)$ ]]; then
            value="${BASH_REMATCH[1]}"
            value="${value%$'\r'}"
            value="${value#"${value%%[![:space:]]*}"}"
            value="${value%"${value##*[![:space:]]}"}"
            case "$value" in
                \"*\") value="${value#\"}"; value="${value%\"}" ;;
                \'*\') value="${value#\'}"; value="${value%\'}" ;;
            esac
            export SDK_PANEL_GATEWAY_SECRET="$value"
            return 0
        fi
    done < "$dotenv"
}

usage() {
    printf 'Uso:\n'
    printf '  bash deploy/linux/dev.sh up [brain|gateway|panel|all]\n'
    printf '  bash deploy/linux/dev.sh down\n'
    printf '  bash deploy/linux/dev.sh status\n'
    printf '  bash deploy/linux/dev.sh manual <brain|gateway|panel|ambos|todos>\n'
}

ensure_brain_deps() {
    if [ ! -d "$REPO/brain/venv" ]; then
        log "🧠 Creando venv del brain (uv)..."
        (cd "$REPO/brain" && uv venv venv && uv pip install -q -r requirements-dev.txt --python venv/bin/python)
    fi
}

ensure_gateway_deps() {
    if [ ! -d "$REPO/gateway/node_modules/eslint" ] || [ ! -d "$REPO/gateway/node_modules/typescript" ] ||
        [ ! -f "$REPO/gateway/node_modules/@sdk-bot/contracts/index.js" ] ||
        ! cmp -s "$REPO/packages/contracts/schema.json" "$REPO/gateway/node_modules/@sdk-bot/contracts/schema.json" ||
        ! cmp -s "$REPO/packages/contracts/index.js" "$REPO/gateway/node_modules/@sdk-bot/contracts/index.js"; then
        log "📦 Instalando devDeps del gateway (NODE_ENV=development)..."
        (cd "$REPO/gateway" && NODE_ENV=development npm ci)
    fi
}

launch_brain() {
    ensure_brain_deps
    wait_port_free "$BRAIN_PORT"
    cd "$REPO/brain"
    # nohup + & deja el listener como job del script; cmd_up hace `disown`
    # para que al terminar dev.sh no reciban SIGHUP. El PID escrito es el
    # listener real (nohup no hace doble fork), así cmd_down lo mata bien.
    NODE_ENV=development BRAIN_PORT="$BRAIN_PORT" BRAIN_HOST="$BRAIN_HOST" \
        nohup "$REPO/brain/venv/bin/python" main.py > /tmp/sdk-bot-brain.log 2>&1 &
    echo $! > "$PID_DIR/brain.pid"
    log "🧠 brain -> pid $(cat "$PID_DIR/brain.pid") (log: /tmp/sdk-bot-brain.log)"
}

launch_gateway() {
    ensure_gateway_deps
    wait_port_free "$STATUS_PORT"
    wait_port_free 5400
    cd "$REPO/gateway"
    NODE_ENV=development SDK_ADMIN_WEB_ENABLED=0 ADMIN_WEB_PORT="$ADMIN_WEB_PORT" STATUS_PORT="$STATUS_PORT" \
        BRAIN_API_BASE="http://127.0.0.1:$BRAIN_PORT" ADMIN_WEB_HOST="$ADMIN_WEB_HOST" STATUS_HOST="$STATUS_HOST" \
        nohup npm start > /tmp/sdk-bot-gateway.log 2>&1 &
    echo $! > "$PID_DIR/gateway.pid"
    log "🌐 gateway -> pid $(cat "$PID_DIR/gateway.pid") (log: /tmp/sdk-bot-gateway.log)"
}

launch_panel() {
    ensure_gateway_deps
    wait_port_free "$ADMIN_WEB_PORT"
    cd "$REPO/gateway/panel"
    NODE_ENV=development ADMIN_WEB_PORT="$ADMIN_WEB_PORT" ADMIN_WEB_HOST="$ADMIN_WEB_HOST" \
        GATEWAY_INTERNAL_URL="http://127.0.0.1:5400" \
        NODE_PATH="$REPO/gateway/node_modules" \
        nohup node index.js > /tmp/sdk-bot-panel.log 2>&1 &
    echo $! > "$PID_DIR/panel.pid"
    log "🖥️ panel -> pid $(cat "$PID_DIR/panel.pid") (log: /tmp/sdk-bot-panel.log)"
}

cmd_up() {
    # Idempotente: mata lo que ya corra (PID file o puerto) antes de relanzar,
    # para no dejar instancias zombie duplicadas ni conflictos de puerto.
    cmd_down >/dev/null
    load_panel_gateway_secret
    if [ "${1:-}" = "all" ] || [ $# -eq 0 ]; then
        launch_brain; sleep 1; launch_gateway; launch_panel
        disown -a 2>/dev/null || true
        return
    fi
    local launched=0
    for target in "$@"; do
        case "$target" in
            brain)   launch_brain; launched=1 ;;
            gateway) launch_gateway; launched=1 ;;
            panel)   launch_panel; launched=1 ;;
            *) log "Componente desconocido: $target (ignorado)";;
        esac
    done
    if [ "$launched" -eq 0 ]; then usage >&2; exit 1; fi
    # Desacopla los jobs del script: al terminar dev.sh no reciben SIGHUP y
    # siguen vivos en segundo plano.
    disown -a 2>/dev/null || true
}

# Espera a que el puerto quede libre (el proceso matado puede tardar en
# soltar el bind). Sin esto hay carrera: el nuevo arranque ve EADDRINUSE.
wait_port_free() {
    local port="$1" tries=40
    while [ "$tries" -gt 0 ]; do
        if fuser "$port/tcp" >/dev/null 2>&1; then
            sleep 0.5
            tries=$((tries - 1))
        else
            return 0
        fi
    done
    # force: mata lo que quede (SIGKILL)
    fuser -k "$port/tcp" >/dev/null 2>&1 || true
    sleep 1
}

kill_pid() {
    local name="$1" pidfile="$2"
    if [ -f "$pidfile" ]; then
        local pid; pid="$(cat "$pidfile")"
        if kill -0 "$pid" 2>/dev/null; then
            log "🛑 matando $name (pid $pid)..."
            kill "$pid" 2>/dev/null || true
        fi
        rm -f "$pidfile"
    fi
}

# Mata cualquier proceso (nuestro o externo) escuchando en el puerto dado.
# Cubre el caso de un gateway/brain/panel levantado manualmente fuera de dev.sh.
kill_by_port() {
    local port="$1" name="$2"
    local pids
    pids="$(fuser "$port/tcp" 2>/dev/null | tr -s ' ')"
    if [ -n "$pids" ]; then
        for p in $pids; do
            # no matar a nosotros mismos (el subshell del dev.sh)
            [ "$p" = "$$" ] && continue
            log "🛑 puerto :$port ocupado por pid $p ($name) — matando..."
            fuser -k "$port/tcp" >/dev/null 2>&1 || true
        done
    fi
}

cmd_down() {
    kill_pid panel   "$PID_DIR/panel.pid"
    kill_pid gateway "$PID_DIR/gateway.pid"
    kill_pid brain   "$PID_DIR/brain.pid"
    # Por si quedó algo en los puertos (lanzado manualmente)
    kill_by_port "$ADMIN_WEB_PORT" panel
    kill_by_port "$STATUS_PORT" gateway
    kill_by_port "$BRAIN_PORT" brain
    # Espera a que los binds se liberen (evita EADDRINUSE en el próximo up)
    wait_port_free "$ADMIN_WEB_PORT"
    wait_port_free "$STATUS_PORT"
    wait_port_free "$BRAIN_PORT"
    # Libera locks de instancia única que queden colgados (el brain se autoprotege)
    rm -f "$REPO/gateway/.gateway.lock" "$REPO/brain/.brain.lock"
    log "✅ detenido (locks liberados)."
}

cmd_status() {
    local ok=0 fail=0
    for svc in brain:5100 gateway:5300 panel:5201; do
        local name="${svc%%:*}" port="${svc##*:}"
        if curl -s -m 4 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
            log "✅ $name :$port up"
        else
            # panel no expone /health; probar solo raíz
            if [ "$name" = "panel" ] && curl -s -m 4 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
                log "✅ $name :$port up"
            else
                log "❌ $name :$port down"
            fi
        fi
    done
}

cmd_manual() {
    # Legacy: comportamiento original (imprime o lanza 1 proceso en foreground)
    local TARGET="${2:-todos}"
    case "$TARGET" in
        brain)
            cd "$REPO/brain"
            exec env NODE_ENV=development BRAIN_PORT="$BRAIN_PORT" BRAIN_HOST="$BRAIN_HOST" venv/bin/python main.py
            ;;
        gateway)
            cd "$REPO/gateway"
            exec env NODE_ENV=development SDK_ADMIN_WEB_ENABLED=0 ADMIN_WEB_PORT="$ADMIN_WEB_PORT" STATUS_PORT="$STATUS_PORT" \
                BRAIN_API_BASE="http://127.0.0.1:$BRAIN_PORT" ADMIN_WEB_HOST="$ADMIN_WEB_HOST" STATUS_HOST="$STATUS_HOST" npm start
            ;;
        panel)
            cd "$REPO/gateway/panel"
            exec env NODE_ENV=development ADMIN_WEB_PORT="$ADMIN_WEB_PORT" ADMIN_WEB_HOST="$ADMIN_WEB_HOST" \
                GATEWAY_INTERNAL_URL="http://127.0.0.1:5400" node index.js
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
        *) usage >&2; exit 1 ;;
    esac
}

case "${1:-}" in
    up)     cmd_up "${@:2}" ;;
    down)   cmd_down ;;
    status) cmd_status ;;
    manual) cmd_manual "$@" ;;
    *) usage >&2; exit 1 ;;
esac
