import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    frontend_dir: Path = ROOT_DIR / "frontend"
    models_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("NOVA_MODELS_DIR") or ROOT_DIR / "data" / "models")
    )
    upload_token: str = field(default_factory=lambda: os.environ.get("UPLOAD_TOKEN", "").strip())
    max_upload_mb: int = field(default_factory=lambda: _int_env("MAX_UPLOAD_MB", 100))
    max_models: int = field(default_factory=lambda: _int_env("MAX_MODELS", 50))
    git_commit: str = field(default_factory=lambda: os.environ.get("GIT_COMMIT", "unknown"))

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def upload_enabled(self) -> bool:
        return bool(self.upload_token)
