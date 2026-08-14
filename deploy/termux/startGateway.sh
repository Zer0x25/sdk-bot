#!/bin/bash
cd /data/data/com.termux/files/home/SDK-Bot/gateway
export NODE_PATH=/data/data/com.termux/files/home/SDK-Bot/gateway/node_modules:$NODE_PATH
export STATUS_PORT=${STATUS_PORT:-5300}
export BRAIN_API_BASE=${BRAIN_API_BASE:-http://127.0.0.1:5100}
export INTERNAL_BUS_PORT=${INTERNAL_BUS_PORT:-5400}
export ADMIN_WEB_PORT=${ADMIN_WEB_PORT:-5201}
exec node index.js
