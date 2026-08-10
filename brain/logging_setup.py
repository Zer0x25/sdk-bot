"""Logging rotado del Brain (R6).

Rotación por tamaño (5MB) con 3 backups en logs/brain.log + salida a consola.
Categorías vía nombre del logger: brain.ai, brain.instancia, brain.perfiles, ...
"""

import logging
import os
from logging.handlers import RotatingFileHandler

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

_FORMATTER = logging.Formatter(
    "%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

_configured = set()


def make_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """Logger con rotación por tamaño + salida a consola (singleton por nombre)."""
    logger = logging.getLogger(name)
    if name in _configured:
        return logger
    logger.setLevel(level)
    fh = RotatingFileHandler(
        os.path.join(LOG_DIR, "brain.log"),
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8"
    )
    fh.setFormatter(_FORMATTER)
    sh = logging.StreamHandler()
    sh.setFormatter(_FORMATTER)
    logger.addHandler(fh)
    logger.addHandler(sh)
    logger.propagate = False
    _configured.add(name)
    return logger
