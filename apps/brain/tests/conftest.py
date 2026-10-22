"""Keep every pytest invocation away from developer Brain state and secrets."""

import atexit
import os
import shutil
import tempfile
from pathlib import Path

_STATE_DIR = Path(tempfile.mkdtemp(prefix="sdkbot-brain-tests-"))
_PROFILE_DIR = _STATE_DIR / "profiles"
_PROFILE_DIR.mkdir()
(_PROFILE_DIR / "default.md").write_text(
    "# Default\nPerfil de prueba.\n\n## Personalidad\nNeutral.\n",
    encoding="utf-8",
)

os.environ["SDK_BRAIN_STATE_DIR"] = str(_STATE_DIR)
os.environ["BRAIN_MEMORY_DB"] = str(_STATE_DIR / "memory.db")
os.environ["SDK_BRAIN_LOCK_PATH"] = str(_STATE_DIR / ".brain.lock")
os.environ["SDK_ADMIN_WEB_LOG_BRAIN"] = str(_STATE_DIR / "logs")
for _secret in ("BRAIN_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"):
    os.environ.pop(_secret, None)

atexit.register(shutil.rmtree, _STATE_DIR, ignore_errors=True)
