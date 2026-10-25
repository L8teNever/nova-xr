import json
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path

from app.model_inspect import ModelInfo

DEFAULT_MODEL_ID = "default"
_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
MAX_NAME_LENGTH = 80


class StoreError(ValueError):
    pass


def clean_name(raw: str | None, fallback: str = "Modell") -> str:
    name = _CONTROL.sub("", raw or "").strip()
    name = re.sub(r"\s+", " ", name)[:MAX_NAME_LENGTH].strip()
    return name or fallback


def is_model_id(value: str) -> bool:
    return bool(_ID_PATTERN.match(value))


class ModelStore:
    """Uploaded models live as '<id>.<format>' plus '<id>.json' metadata in one directory."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self._lock = threading.Lock()

    def ensure_dir(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    def _meta_path(self, model_id: str) -> Path:
        return self.directory / f"{model_id}.json"

    def file_path(self, meta: dict) -> Path:
        return self.directory / f"{meta['id']}.{meta['format']}"

    def list(self) -> list[dict]:
        if not self.directory.is_dir():
            return []
        items = []
        for path in self.directory.glob("*.json"):
            if not is_model_id(path.stem):
                continue
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if self.file_path(meta).is_file():
                items.append(meta)
        items.sort(key=lambda item: item.get("created", 0))
        return items

    def count(self) -> int:
        return len(self.list())

    def get(self, model_id: str) -> dict | None:
        if not is_model_id(model_id):
            return None
        path = self._meta_path(model_id)
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return meta if self.file_path(meta).is_file() else None

    def _write_json(self, path: Path, data: dict) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=".meta-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def add(self, temp_file: Path, name: str, original_filename: str, info: ModelInfo, size: int) -> dict:
        model_id = uuid.uuid4().hex
        meta = {
            "id": model_id,
            "name": clean_name(name, fallback=clean_name(Path(original_filename).stem)),
            "format": info.format,
            "size": size,
            "created": time.time(),
            "original_filename": clean_name(Path(original_filename).name, fallback="upload"),
            "builtin": False,
            "info": info.to_dict(),
        }
        with self._lock:
            os.replace(temp_file, self.file_path(meta))
            self._write_json(self._meta_path(model_id), meta)
        return meta

    def rename(self, model_id: str, name: str) -> dict:
        with self._lock:
            meta = self.get(model_id)
            if meta is None:
                raise KeyError(model_id)
            meta["name"] = clean_name(name, fallback=meta["name"])
            self._write_json(self._meta_path(model_id), meta)
        return meta

    def delete(self, model_id: str) -> None:
        with self._lock:
            meta = self.get(model_id)
            if meta is None:
                raise KeyError(model_id)
            self.file_path(meta).unlink(missing_ok=True)
            self._meta_path(model_id).unlink(missing_ok=True)
