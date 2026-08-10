#!/bin/bash
cd /data/data/com.termux/files/home/SDK-Bot/brain
export PYTHONPATH=/data/data/com.termux/files/home/SDK-Bot/brain:$PYTHONPATH
if [ -f venv/bin/activate ]; then
    source venv/bin/activate
fi
exec python main.py
