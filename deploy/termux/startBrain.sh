#!/bin/bash
cd /data/data/com.termux/files/home/SDK-Bot/apps/brain
export SDK_BRAIN_STATE_DIR=/data/data/com.termux/files/home/SDK-Bot/brain
export PYTHONPATH=/data/data/com.termux/files/home/SDK-Bot/apps/brain:$PYTHONPATH
export BRAIN_PORT=${BRAIN_PORT:-5100}
export BRAIN_HOST=${BRAIN_HOST:-0.0.0.0}
exec python main.py
