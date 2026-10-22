FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STT_MODEL=base \
    STT_DEVICE=cpu \
    STT_COMPUTE_TYPE=int8 \
    STT_CACHE=/var/lib/sdk-bot-stt/models \
    STT_PORT=9000

WORKDIR /app

# Deps primero (capa cacheable). faster-whisper tira de torch/ctranslate2.
COPY apps/stt/requirements.txt /app/stt/requirements.txt
RUN pip install --no-cache-dir -r /app/stt/requirements.txt

COPY apps/stt /app/stt

# El modelo se descarga en runtime al primer uso y se cachea en el volumen
# montado en STT_CACHE (ver compose.yml). No lo bajamos en build para
# mantener la imagen ligera y permitir swapear de modelo sin rebuild.
RUN mkdir -p /var/lib/sdk-bot-stt/models

WORKDIR /app/stt
EXPOSE 9000
CMD ["python", "server.py"]
