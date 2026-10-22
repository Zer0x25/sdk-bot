#!/bin/bash
cd /data/data/com.termux/files/home/SDK-Bot/apps/gateway
# Contratos locales empaquetados por npm: actualizar tras cambios del schema.
if [ ! -f node_modules/@sdk-bot/contracts/index.js ] ||
   ! cmp -s ../../packages/contracts/schema.json node_modules/@sdk-bot/contracts/schema.json ||
   ! cmp -s ../../packages/contracts/index.js node_modules/@sdk-bot/contracts/index.js; then
    npm ci || exit 1
fi
export NODE_PATH=/data/data/com.termux/files/home/SDK-Bot/apps/gateway/node_modules:$NODE_PATH
export STATUS_PORT=${STATUS_PORT:-5300}
export BRAIN_API_BASE=${BRAIN_API_BASE:-http://127.0.0.1:5100}
export INTERNAL_BUS_PORT=${INTERNAL_BUS_PORT:-5400}
export ADMIN_WEB_PORT=${ADMIN_WEB_PORT:-5201}
exec node index.js
