#!/bin/bash
cd /data/data/com.termux/files/home/SDK-Bot/brain
export PYTHONPATH=/data/data/com.termux/files/home/SDK-Bot/brain:$PYTHONPATH
export BRAIN_PORT=${BRAIN_PORT:-5100}
export BRAIN_HOST=${BRAIN_HOST:-0.0.0.0}
if [ -f venv/bin/activate ]; then
    source venv/bin/activate
fi
exec python main.py
