import mimetypes
import os
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.glb_inspect import GlbError, inspect_glb
from app.storage import (
    active_glb_path,
    clear_custom,
    max_upload_bytes,
    model_status,
    save_custom,
)

mimetypes.add_type("model/gltf-binary", ".glb")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
GIT_COMMIT = os.environ.get("GIT_COMMIT", "unknown")

app = FastAPI(title="Nova", version=__version__)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/version")
def version() -> dict[str, str]:
    return {"name": "Nova", "version": __version__, "git_commit": GIT_COMMIT}


@app.get("/api/model")
def model_info() -> dict:
    return model_status()


@app.get("/api/character.glb")
def character_glb() -> FileResponse:
    path = active_glb_path()
    if not path.is_file():
        return JSONResponse({"detail": "Kein Modell vorhanden."}, status_code=404)
    return FileResponse(path, media_type="model/gltf-binary")


@app.post("/api/model")
async def upload_model(file: UploadFile = File(...)):
    name = file.filename or "upload.glb"
    if not name.lower().endswith(".glb"):
        return JSONResponse({"detail": "Nur .glb (glTF binary) wird angenommen."}, status_code=400)
    data = await file.read()
    if not data:
        return JSONResponse({"detail": "Leere Datei."}, status_code=400)
    limit = max_upload_bytes()
    if len(data) > limit:
        return JSONResponse(
            {"detail": f"Datei zu groß (max. {limit} Bytes)."},
            status_code=413,
        )
    try:
        info = inspect_glb(data)
    except GlbError as error:
        return JSONResponse({"detail": str(error)}, status_code=400)
    if not info.rigged:
        return JSONResponse(
            {
                "detail": "Kein Skelett/Skin erkannt. Bitte ein geriggtes GLB hochladen.",
                "rigged": False,
                "animated": info.animated,
                "animations": info.animation_names,
            },
            status_code=400,
        )
    meta = save_custom(data, info, name)
    meta["warning"] = None
    if not info.animated:
        meta["warning"] = "Kein Animationsclip gefunden. Platzieren nutzt prozedurales Idle."
    return meta


@app.delete("/api/model")
def delete_custom_model() -> dict:
    clear_custom()
    return model_status()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


if FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/{asset_path:path}")
def frontend_asset(asset_path: str):
    if asset_path.startswith("api/") or asset_path in {"health", "api/version"}:
        return JSONResponse({"detail": "Not found"}, status_code=404)
    if asset_path == "assets/models/character.glb":
        path = active_glb_path()
        if path.is_file():
            return FileResponse(path, media_type="model/gltf-binary")
        return JSONResponse({"detail": "Not found"}, status_code=404)
    candidate = (FRONTEND_DIR / asset_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIR.resolve())
    except ValueError:
        return JSONResponse({"detail": "Not found"}, status_code=404)
    if candidate.is_file():
        media_type = None
        if candidate.suffix.lower() == ".glb":
            media_type = "model/gltf-binary"
        return FileResponse(candidate, media_type=media_type)
    return JSONResponse({"detail": "Not found"}, status_code=404)
