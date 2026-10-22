"""Resolve source and mutable Brain state directories independently."""

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def resolve_brain_state_dir(configured: str | None = None) -> Path:
    if configured is None:
        configured = os.environ.get("SDK_BRAIN_STATE_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return REPO_ROOT / "brain"


BRAIN_STATE_DIR = resolve_brain_state_dir()
BRAIN_ENV_PATH = BRAIN_STATE_DIR / ".env"
