FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY apps/brain/requirements.txt apps/brain/requirements.txt
RUN pip install --no-cache-dir -r apps/brain/requirements.txt

COPY apps/brain apps/brain
COPY .env.tuning .env.tuning

ENV SDK_BRAIN_STATE_DIR=/app/brain
RUN mkdir -p /app/brain/logs /app/brain/profiles

WORKDIR /app/apps/brain
CMD ["python", "main.py"]
