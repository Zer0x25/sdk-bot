"""Lock ownership used by the offline factory-reset preflight (BUG-031)."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main as brain_main


def test_configured_lock_is_published_and_removed_in_child(tmp_path):
    target = tmp_path / "nested" / "brain.lock"
    env = {
        **os.environ,
        "SDK_BRAIN_LOCK_PATH": str(target),
        "BRAIN_MEMORY_DB": str(tmp_path / "memory.db"),
        "GEMINI_API_KEY": "", "GROQ_API_KEY": "", "OPENROUTER_API_KEY": "",
    }
    code = """
import os
from pathlib import Path
import main
target = Path(os.environ['SDK_BRAIN_LOCK_PATH'])
assert main.BRAIN_LOCK_FILE == str(target)
assert not target.exists()
main._write_lock()
assert main._read_lock() == os.getpid()
assert target.read_text() == str(os.getpid())
target.write_text(str(os.getpid() + 1))
main._remove_lock()
assert target.exists(), 'must not unlink another owner'
main._write_lock()
main._remove_lock()
assert not target.exists()
"""
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=Path(brain_main.__file__).parent,
        env=env, capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert not target.exists()


def test_singleton_aborts_startup_if_lock_cannot_be_written(tmp_path, monkeypatch):
    target = tmp_path / "directory-is-not-a-lock-file"
    target.mkdir()
    monkeypatch.setattr(brain_main, "BRAIN_LOCK_FILE", str(target))
    monkeypatch.setattr(brain_main, "_port_in_use", lambda _port: False)
    with pytest.raises(OSError):
        brain_main.ensure_singleton()
    assert target.is_dir()
