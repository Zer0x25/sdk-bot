#!/bin/bash
cd /data/data/com.termux/files/home/SDK-Bot/gateway
export NODE_PATH=/data/data/com.termux/files/home/SDK-Bot/gateway/node_modules:$NODE_PATH
exec node index.js
