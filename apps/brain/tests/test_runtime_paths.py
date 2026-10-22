from pathlib import Path

from runtime_paths import REPO_ROOT, resolve_brain_state_dir


def test_state_dir_defaults_to_root_runtime_directory(monkeypatch):
    monkeypatch.delenv("SDK_BRAIN_STATE_DIR", raising=False)
    assert resolve_brain_state_dir() == REPO_ROOT / "brain"


def test_state_dir_accepts_configured_directory(monkeypatch, tmp_path):
    configured = tmp_path / "brain-state"
    monkeypatch.setenv("SDK_BRAIN_STATE_DIR", str(configured))
    assert resolve_brain_state_dir() == configured.resolve()


def test_explicit_state_dir_takes_precedence_over_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("SDK_BRAIN_STATE_DIR", str(tmp_path / "environment"))
    assert resolve_brain_state_dir(str(tmp_path / "explicit")) == (tmp_path / "explicit").resolve()
