import json
import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _glb(gltf: dict) -> bytes:
    payload = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    pad = (4 - (len(payload) % 4)) % 4
    payload += b" " * pad
    json_chunk = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    total = 12 + len(json_chunk)
    header = struct.pack("<III", 0x46546C67, 2, total)
    return header + json_chunk


RIGGED = _glb(
    {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "Hips", "skin": 0}, {"name": "Spine"}],
        "skins": [{"joints": [0, 1]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "animations": [{"name": "walk", "channels": [], "samplers": []}],
        "accessors": [],
        "bufferViews": [],
        "buffers": [],
    }
)

STATIC = _glb(
    {
        "asset": {"version": "2.0"},
        "nodes": [{"name": "Mesh"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
    }
)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("NOVA_DATA_DIR", str(tmp_path / "data"))
    from app import main, storage

    monkeypatch.setattr(storage, "DATA_DIR", Path(tmp_path / "data"), raising=False)
    return TestClient(main.app)


def test_model_status_bundled(client):
    response = client.get("/api/model")
    assert response.status_code == 200
    assert response.json()["active"] == "bundled"


def test_reject_non_glb(client):
    response = client.post("/api/model", files={"file": ("x.txt", b"hello", "text/plain")})
    assert response.status_code == 400


def test_reject_unrigged(client):
    response = client.post("/api/model", files={"file": ("prop.glb", STATIC, "model/gltf-binary")})
    assert response.status_code == 400
    assert "Skelett" in response.json()["detail"]


def test_accept_rigged_and_serve(client):
    response = client.post("/api/model", files={"file": ("hero.glb", RIGGED, "model/gltf-binary")})
    assert response.status_code == 200
    body = response.json()
    assert body["rigged"] is True
    assert body["animated"] is True
    assert "walk" in body["animations"]

    served = client.get("/api/character.glb")
    assert served.status_code == 200
    assert served.content == RIGGED

    status = client.get("/api/model").json()
    assert status["active"] == "custom"

    deleted = client.delete("/api/model")
    assert deleted.status_code == 200
    assert deleted.json()["active"] == "bundled"
