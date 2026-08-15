FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY brain/requirements.txt brain/requirements.txt
RUN pip install --no-cache-dir -r brain/requirements.txt

COPY brain brain
COPY .env.tuning .env.tuning

RUN mkdir -p /app/brain/logs

WORKDIR /app/brain
CMD ["python", "main.py"]
