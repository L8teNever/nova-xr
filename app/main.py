import hmac
import logging
import mimetypes
import os
import tempfile
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from app import __version__
from app.config import Settings
from app.model_inspect import EXTENSIONS, ModelError, inspect_file
from app.models_store import DEFAULT_MODEL_ID, MAX_NAME_LENGTH, ModelStore

mimetypes.add_type("model/gltf-binary", ".glb")
mimetypes.add_type("model/gltf-binary", ".vrm")
mimetypes.add_type("model/gltf+json", ".gltf")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")

log = logging.getLogger("nova")

MEDIA_TYPES = {"glb": "model/gltf-binary", "vrm": "model/gltf-binary", "gltf": "model/gltf+json"}
DEFAULT_MODEL = {
    "id": DEFAULT_MODEL_ID,
    "name": "Standard-Figur",
    "format": "glb",
    "builtin": True,
}
CHUNK_SIZE = 1024 * 1024


class RenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)


class AuthThrottle:
    """Lock out a client after repeated wrong tokens. In-memory, per process."""

    def __init__(self, max_failures: int = 10, window_s: float = 300.0):
        self.max_failures = max_failures
        self.window_s = window_s
        self._failures: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> list[float]:
        hits = [t for t in self._failures.get(key, []) if now - t < self.window_s]
        self._failures[key] = hits
        return hits

    def blocked(self, key: str) -> bool:
        with self._lock:
            return len(self._recent(key, time.monotonic())) >= self.max_failures

    def fail(self, key: str) -> None:
        with self._lock:
            now = time.monotonic()
            self._recent(key, now).append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


def _request_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.headers.get("x-upload-token", "").strip()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    store = ModelStore(settings.models_dir)
    throttle = AuthThrottle()
    frontend_dir = settings.frontend_dir.resolve()
    default_model_path = frontend_dir / "assets" / "models" / "character.glb"

    app = FastAPI(title="Nova", version=__version__)
    app.state.settings = settings
    app.state.store = store

    try:
        store.ensure_dir()
    except OSError as exc:
        log.warning("Modellverzeichnis %s nicht beschreibbar: %s", settings.models_dir, exc)
    if settings.upload_token and len(settings.upload_token) < 12:
        log.warning("UPLOAD_TOKEN ist kürzer als 12 Zeichen – bitte ein langes Zufallstoken nutzen.")

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    def require_token(request: Request) -> None:
        if not settings.upload_enabled:
            raise HTTPException(403, "Upload ist deaktiviert (UPLOAD_TOKEN in der .env setzen).")
        client = request.client.host if request.client else "unknown"
        if throttle.blocked(client):
            raise HTTPException(429, "Zu viele falsche Token-Versuche. Bitte später erneut versuchen.")
        token = _request_token(request)
        if not token or not hmac.compare_digest(token.encode(), settings.upload_token.encode()):
            throttle.fail(client)
            raise HTTPException(401, "Token fehlt oder ist falsch.", headers={"WWW-Authenticate": "Bearer"})
        throttle.reset(client)

    def default_entry() -> dict:
        size = default_model_path.stat().st_size if default_model_path.is_file() else 0
        return {**DEFAULT_MODEL, "size": size, "url": f"/api/models/{DEFAULT_MODEL_ID}/file"}

    def public_entry(meta: dict) -> dict:
        return {**meta, "url": f"/api/models/{meta['id']}/file"}

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/version")
    def version() -> dict[str, str]:
        return {"name": "Nova", "version": __version__, "git_commit": settings.git_commit}

    @app.get("/api/config")
    def config() -> dict:
        return {
            "upload_enabled": settings.upload_enabled,
            "max_upload_mb": settings.max_upload_mb,
            "max_models": settings.max_models,
            "formats": sorted(EXTENSIONS),
        }

    @app.get("/api/models")
    def list_models() -> dict:
        return {"models": [default_entry(), *(public_entry(m) for m in store.list())]}

    @app.get("/api/models/{model_id}")
    def get_model(model_id: str) -> dict:
        if model_id == DEFAULT_MODEL_ID:
            return default_entry()
        meta = store.get(model_id)
        if meta is None:
            raise HTTPException(404, "Modell nicht gefunden.")
        return public_entry(meta)

    @app.get("/api/models/{model_id}/file")
    def model_file(model_id: str) -> FileResponse:
        if model_id == DEFAULT_MODEL_ID:
            if not default_model_path.is_file():
                raise HTTPException(404, "Standard-Modell fehlt im Image.")
            return FileResponse(
                default_model_path, media_type=MEDIA_TYPES["glb"], headers={"Cache-Control": "no-cache"}
            )
        meta = store.get(model_id)
        if meta is None:
            raise HTTPException(404, "Modell nicht gefunden.")
        return FileResponse(
            store.file_path(meta),
            media_type=MEDIA_TYPES[meta["format"]],
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    @app.post("/api/models", status_code=201, dependencies=[Depends(require_token)])
    async def upload_model(request: Request, filename: str = "", name: str = "") -> dict:
        filename = filename or request.headers.get("x-filename", "")
        suffix = Path(filename).suffix.lower()
        fmt = EXTENSIONS.get(suffix)
        if fmt is None:
            raise HTTPException(415, "Dateityp nicht erlaubt (nur .glb, .gltf, .vrm).")
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.max_upload_bytes:
            raise HTTPException(413, f"Datei größer als {settings.max_upload_mb} MB.")
        if store.count() >= settings.max_models:
            raise HTTPException(409, f"Maximal {settings.max_models} Modelle. Bitte erst eines löschen.")

        try:
            store.ensure_dir()
            fd, tmp_name = tempfile.mkstemp(dir=settings.models_dir, prefix=".upload-", suffix=".part")
        except OSError as exc:
            raise HTTPException(500, "Modellverzeichnis ist nicht beschreibbar.") from exc
        tmp_path = Path(tmp_name)
        size = 0
        try:
            with os.fdopen(fd, "wb") as handle:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(413, f"Datei größer als {settings.max_upload_mb} MB.")
                    handle.write(chunk)
            if size == 0:
                raise HTTPException(400, "Leere Datei.")
            try:
                info = inspect_file(tmp_path, fmt)
            except ModelError as exc:
                raise HTTPException(422, str(exc)) from exc
            meta = store.add(tmp_path, name, filename, info, size)
        finally:
            tmp_path.unlink(missing_ok=True)
        log.info("Modell hochgeladen: %s (%s, %d Bytes)", meta["id"], meta["format"], size)
        return public_entry(meta)

    @app.patch("/api/models/{model_id}", dependencies=[Depends(require_token)])
    def rename_model(model_id: str, body: RenameRequest) -> dict:
        if model_id == DEFAULT_MODEL_ID:
            raise HTTPException(400, "Das Standard-Modell kann nicht umbenannt werden.")
        try:
            return public_entry(store.rename(model_id, body.name))
        except KeyError as exc:
            raise HTTPException(404, "Modell nicht gefunden.") from exc

    @app.delete("/api/models/{model_id}", status_code=204, dependencies=[Depends(require_token)])
    def delete_model(model_id: str) -> None:
        if model_id == DEFAULT_MODEL_ID:
            raise HTTPException(400, "Das Standard-Modell kann nicht gelöscht werden.")
        try:
            store.delete(model_id)
        except KeyError as exc:
            raise HTTPException(404, "Modell nicht gefunden.") from exc

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(frontend_dir / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/{asset_path:path}")
    def frontend_asset(asset_path: str):
        if asset_path.startswith("api/") or asset_path == "health":
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = (frontend_dir / asset_path).resolve()
        if not candidate.is_relative_to(frontend_dir) or not candidate.is_file():
            return JSONResponse({"detail": "Not found"}, status_code=404)
        headers = {"Cache-Control": "no-cache"} if candidate.suffix in {".html", ".js", ".css"} else None
        return FileResponse(candidate, headers=headers)

    return app


app = create_app()
