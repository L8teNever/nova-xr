import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
GIT_COMMIT = os.environ.get("GIT_COMMIT", "unknown")

app = FastAPI(title="Nova", version=__version__)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/version")
def version() -> dict[str, str]:
    return {"name": "Nova", "version": __version__, "git_commit": GIT_COMMIT}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


if FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/{asset_path:path}")
def frontend_asset(asset_path: str):
    """Serve frontend files without a /static prefix for relative URLs."""
    if asset_path in {"health", "api/version"}:
        return JSONResponse({"detail": "Not found"}, status_code=404)
    candidate = (FRONTEND_DIR / asset_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIR.resolve())
    except ValueError:
        return JSONResponse({"detail": "Not found"}, status_code=404)
    if candidate.is_file():
        return FileResponse(candidate)
    return JSONResponse({"detail": "Not found"}, status_code=404)
