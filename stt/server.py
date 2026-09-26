#!/usr/bin/env python3
"""
SDK-BOT — Servicio STT local (speech-to-text).

Expone un endpoint OpenAI-compatible:

    POST /v1/audio/transcriptions
        form-data:
            file:        <audio binario (.ogg/.opus/.mp3/.wav/.m4a)>
            model:      <ignorado, se usa STT_MODEL del entorno>
            language:   opcional, forza idioma (ej. "es")
            temperature: opcional
        -> {"text": "..."}

El gateway (Node) es el único cliente: descarga el audio del canal y lo
manda aquí. El servicio corre 100% local (CPU, int8) detrás de la red
Docker interna / Tailscale; no se expone a internet.

Modelo: se carga en arranque desde STT_MODEL (default "base"). El binario
del modelo se cachea en STT_CACHE (volumen en producción) para no
re-descargarlo en cada reinicio.
"""
from __future__ import annotations

import asyncio
import os
import time
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("stt")

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

try:
    from faster_whisper import WhisperModel
except Exception as exc:  # pragma: no cover - falla si deps no instaladas
    WhisperModel = None
    _IMPORT_ERROR = exc

# ---------------------------------------------------------------------------
# Configuración (env-driven, sin secretos)
# ---------------------------------------------------------------------------
MODEL_SIZE = os.getenv("STT_MODEL", "base")          # base | small | tiny ...
DEVICE = os.getenv("STT_DEVICE", "cpu")              # cpu | cuda
COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8") # int8 | int8_float16 | float16
CACHE_DIR = os.getenv("STT_CACHE", "/var/lib/sdk-bot-stt/models")
HOST = os.getenv("STT_HOST", "0.0.0.0")
PORT = int(os.getenv("STT_PORT", "9000"))
# Tope de seguridad: rechaza audios mayores a esto (bytes). ~5 MB cubre 2 min opus.
MAX_UPLOAD_BYTES = int(os.getenv("STT_MAX_UPLOAD_BYTES", str(5 * 1024 * 1024)))
# Idioma por defecto (fijar "es" acelera y mejora accuracy si siempre español).
DEFAULT_LANGUAGE = os.getenv("STT_LANGUAGE", "") or None

Path(CACHE_DIR).mkdir(parents=True, exist_ok=True)

app = FastAPI(title="SDK-Bot STT", version="1.0.0")

_model = None
_model_loaded_at = 0.0


def get_model() -> "WhisperModel":
    """Carga el modelo bajo demanda (lazy) y lo cachea en RAM."""
    global _model, _model_loaded_at
    if WhisperModel is None:  # pragma: no cover
        raise HTTPException(
            status_code=503,
            detail=f"Dependencias STT no instaladas: {_IMPORT_ERROR}",
        )
    if _model is None:
        log.info(f"Cargando modelo whisper '{MODEL_SIZE}' ({DEVICE}/{COMPUTE_TYPE})...")
        t0 = time.time()
        _model = WhisperModel(
            MODEL_SIZE,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            download_root=CACHE_DIR,
            cpu_threads=max(1, (os.cpu_count() or 2) // 2),
        )
        _model_loaded_at = time.time()
        log.info(f"Modelo listo en {_model_loaded_at - t0:.1f}s")
    return _model


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "ready": _model is not None,
        "loaded_at": _model_loaded_at or None,
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(""),          # ignorado (compat OpenAI)
    language: str = Form(""),
    temperature: float = Form(0.0),
):
    # 1) Tope de tamaño (evita OOM por audio gigante).
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio demasiado grande: {len(data)} bytes > {MAX_UPLOAD_BYTES}",
        )
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Audio vacío")

    # 2) faster-whisper acepta el binario directo; la extensión del filename
    #    solo influye en la detección de formato. Forzamos por content-type
    #    del canal vía el nombre original cuando viene.
    suffix = ""
    if file.filename and "." in file.filename:
        suffix = "." + file.filename.rsplit(".", 1)[-1].lower()
    tmp = Path(CACHE_DIR) / f"req-{int(time.time()*1000)}-{os.getpid()}{suffix}"
    tmp.write_bytes(data)

    try:
        def _do_transcribe():
            whisper = get_model()
            lang = language or DEFAULT_LANGUAGE
            segments, _info = whisper.transcribe(
                str(tmp),
                language=lang or None,
                temperature=temperature,
                # beam_size pequeño: base es rápido y suficiente para voz casual.
                beam_size=5,
                vad_filter=True,          # recorta silencios => menos basura
                vad_parameters=dict(min_silence_duration_ms=500),
            )
            return "".join(seg.text for seg in segments).strip()

        text = await asyncio.to_thread(_do_transcribe)
        return JSONResponse({"text": text})
    except HTTPException:
        raise
    except Exception as exc:  # transcripción falló (codec, corruption)
        raise HTTPException(status_code=422, detail=f"Fallo STT: {exc}")
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
