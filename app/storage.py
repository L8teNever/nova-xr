import json
import os
from pathlib import Path

from app.glb_inspect import GlbInfo

BUNDLED_GLB = Path(__file__).resolve().parent.parent / "frontend" / "assets" / "models" / "character.glb"


def data_dir() -> Path:
    return Path(os.environ.get("NOVA_DATA_DIR", "data")).resolve()


def custom_glb() -> Path:
    return data_dir() / "custom.glb"


def custom_meta() -> Path:
    return data_dir() / "custom.json"


def max_upload_bytes() -> int:
    return int(os.environ.get("NOVA_MAX_UPLOAD_BYTES", str(40 * 1024 * 1024)))


MAX_UPLOAD_BYTES = max_upload_bytes()


def ensure_data_dir() -> None:
    data_dir().mkdir(parents=True, exist_ok=True)


def has_custom() -> bool:
    return custom_glb().is_file()


def active_glb_path() -> Path:
    return custom_glb() if has_custom() else BUNDLED_GLB


def save_custom(data: bytes, info: GlbInfo, filename: str) -> dict:
    ensure_data_dir()
    custom_glb().write_bytes(data)
    meta = {
        "source": "upload",
        "filename": filename,
        "bytes": len(data),
        "rigged": info.rigged,
        "animated": info.animated,
        "skins": info.skin_count,
        "joints": info.joint_count,
        "meshes": info.mesh_count,
        "animations": info.animation_names,
    }
    custom_meta().write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def clear_custom() -> None:
    glb = custom_glb()
    meta = custom_meta()
    if glb.exists():
        glb.unlink()
    if meta.exists():
        meta.unlink()


def model_status() -> dict:
    meta_path = custom_meta()
    if has_custom() and meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["active"] = "custom"
        return meta
    return {
        "active": "bundled",
        "source": "bundled",
        "filename": "character.glb",
        "rigged": True,
        "animated": True,
        "note": "Mitgeliefertes Standardmodell.",
    }
