import base64
import json
import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import ROOT_DIR, Settings
from app.main import create_app
from app.model_inspect import ModelError, inspect_bytes, inspect_file, normalize_bone

TOKEN = "unit-test-token-0123456789"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
HUMANOID_BONES = [
    "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Head",
    "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot",
    "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot",
]


def gltf_json(bones=HUMANOID_BONES, extensions=None, **extra) -> dict:
    nodes = [{"name": name} for name in bones] + [{"name": "Body", "mesh": 0, "skin": 0}]
    doc = {
        "asset": {"version": "2.0"},
        "nodes": nodes,
        "meshes": [{"primitives": [{"attributes": {}}]}],
        "skins": [{"joints": list(range(len(bones)))}],
        "animations": [{"name": "Idle", "channels": [], "samplers": []}],
    }
    if extensions:
        doc["extensionsUsed"] = list(extensions)
        doc["extensions"] = {name: {} for name in extensions}
    doc.update(extra)
    return doc


def make_glb(doc: dict | None = None, pad_to: int = 0) -> bytes:
    payload = json.dumps(doc or gltf_json()).encode()
    payload += b" " * ((4 - len(payload) % 4) % 4)
    binary = b"\x00" * pad_to
    chunks = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    if binary:
        chunks += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks


@pytest.fixture
def make_client(tmp_path):
    def factory(**overrides) -> TestClient:
        settings = Settings(
            models_dir=tmp_path / "models",
            upload_token=overrides.pop("upload_token", TOKEN),
            max_upload_mb=overrides.pop("max_upload_mb", 1),
            max_models=overrides.pop("max_models", 5),
            **overrides,
        )
        return TestClient(create_app(settings))

    return factory


@pytest.fixture
def client(make_client):
    return make_client()


def upload(client, data: bytes, filename="figur.glb", name="", headers=AUTH):
    return client.post(
        "/api/models",
        params={"filename": filename, "name": name},
        content=data,
        headers={**headers, "Content-Type": "application/octet-stream"},
    )


def test_list_contains_default_model(client):
    models = client.get("/api/models").json()["models"]
    assert models[0]["id"] == "default"
    assert models[0]["builtin"] is True
    file = client.get(models[0]["url"])
    assert file.status_code == 200
    assert file.headers["content-type"].startswith("model/gltf-binary")


def test_config_reports_upload_state(make_client):
    assert make_client().get("/api/config").json()["upload_enabled"] is True
    disabled = make_client(upload_token="").get("/api/config").json()
    assert disabled["upload_enabled"] is False
    assert disabled["max_upload_mb"] == 1


def test_upload_requires_token(client):
    assert upload(client, make_glb(), headers={}).status_code == 401
    assert upload(client, make_glb(), headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert upload(client, make_glb(), headers={"X-Upload-Token": "wrong"}).status_code == 401
    assert len(client.get("/api/models").json()["models"]) == 1


def test_upload_disabled_without_configured_token(make_client):
    client = make_client(upload_token="")
    response = upload(client, make_glb(), headers={"Authorization": "Bearer "})
    assert response.status_code == 403


def test_wrong_tokens_are_throttled(client):
    for _ in range(10):
        assert upload(client, make_glb(), headers={"Authorization": "Bearer nope"}).status_code == 401
    assert upload(client, make_glb(), headers={"Authorization": "Bearer nope"}).status_code == 429
    assert upload(client, make_glb()).status_code == 429


def test_upload_glb_roundtrip(client, tmp_path):
    data = make_glb(pad_to=64)
    response = upload(client, data, name="  Meine   Figur ", headers={"X-Upload-Token": TOKEN})
    assert response.status_code == 201, response.text
    meta = response.json()
    assert meta["name"] == "Meine Figur"
    assert meta["format"] == "glb"
    assert meta["size"] == len(data)
    assert meta["info"]["humanoid"] is True
    assert meta["info"]["animations"] == ["Idle"]

    stored = list((tmp_path / "models").iterdir())
    assert sorted(p.suffix for p in stored) == [".glb", ".json"]
    file = client.get(meta["url"])
    assert file.status_code == 200
    assert file.content == data
    assert "immutable" in file.headers["cache-control"]
    ids = [m["id"] for m in client.get("/api/models").json()["models"]]
    assert ids == ["default", meta["id"]]


def test_uploads_persist_across_app_restarts(make_client):
    meta = upload(make_client(), make_glb(), name="Bleibt").json()
    again = make_client().get("/api/models").json()["models"]
    assert [m["name"] for m in again] == ["Standard-Figur", "Bleibt"]
    assert again[1]["id"] == meta["id"]


def test_name_falls_back_to_filename(client):
    meta = upload(client, make_glb(), filename="Heldin.glb").json()
    assert meta["name"] == "Heldin"
    assert meta["original_filename"] == "Heldin.glb"


def test_upload_vrm(client):
    data = make_glb(gltf_json(bones=["J_Bip_C_Hips"], extensions=["VRMC_vrm"]))
    meta = upload(client, data, filename="avatar.vrm").json()
    assert meta["format"] == "vrm"
    assert meta["info"]["vrm_version"] == "1.0"
    assert meta["info"]["humanoid"] is True
    assert client.get(meta["url"]).headers["content-type"].startswith("model/gltf-binary")


def test_vrm_extension_without_vrm_data_is_rejected(client):
    response = upload(client, make_glb(), filename="fake.vrm")
    assert response.status_code == 422
    assert "VRM" in response.json()["detail"]


def test_upload_embedded_gltf(client):
    buffer = "data:application/octet-stream;base64," + base64.b64encode(b"\x00" * 8).decode()
    doc = gltf_json(buffers=[{"uri": buffer, "byteLength": 8}])
    meta = upload(client, json.dumps(doc).encode(), filename="szene.gltf").json()
    assert meta["format"] == "gltf"
    assert client.get(meta["url"]).headers["content-type"].startswith("model/gltf+json")


def test_gltf_with_external_resources_is_rejected(client):
    doc = gltf_json(buffers=[{"uri": "scene.bin", "byteLength": 8}])
    response = upload(client, json.dumps(doc).encode(), filename="szene.gltf")
    assert response.status_code == 422
    assert "externe" in response.json()["detail"]


@pytest.mark.parametrize(
    "filename,data,status",
    [
        ("bild.png", b"\x89PNG....", 415),
        ("ohne-endung", make_glb(), 415),
        ("figur.glb", b"", 400),
        ("figur.glb", b"not a glb at all, just text", 422),
        ("figur.glb", make_glb()[:-4], 422),
        ("figur.glb", struct.pack("<III", 0x46546C67, 1, 12), 422),
        ("figur.gltf", make_glb(), 422),
        ("figur.gltf", b"{not json", 422),
        ("figur.glb", make_glb({"asset": {"version": "1.0"}, "meshes": [{}]}), 422),
        ("figur.glb", make_glb({"asset": {"version": "2.0"}}), 422),
    ],
)
def test_invalid_files_are_rejected(client, tmp_path, filename, data, status):
    response = upload(client, data, filename=filename)
    assert response.status_code == status, response.text
    leftovers = [p for p in (tmp_path / "models").iterdir()] if (tmp_path / "models").exists() else []
    assert leftovers == []


def test_size_limit_by_content_length(client):
    response = upload(client, make_glb(pad_to=1024 * 1024 + 16))
    assert response.status_code == 413


def test_size_limit_while_streaming(client, tmp_path):
    def chunks():
        for _ in range(3):
            yield b"\x00" * (512 * 1024)

    response = client.post(
        "/api/models", params={"filename": "gross.glb"}, content=chunks(), headers=AUTH
    )
    assert response.status_code == 413
    assert list((tmp_path / "models").iterdir()) == []


def test_model_count_limit(make_client):
    client = make_client(max_models=2)
    assert upload(client, make_glb()).status_code == 201
    assert upload(client, make_glb()).status_code == 201
    assert upload(client, make_glb()).status_code == 409


def test_rename_and_delete(client):
    meta = upload(client, make_glb(), name="Alt").json()
    url = f"/api/models/{meta['id']}"

    assert client.patch(url, json={"name": "Neu"}).status_code == 401
    renamed = client.patch(url, json={"name": " Neu\x07 "}, headers=AUTH)
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Neu"
    assert client.get(url).json()["name"] == "Neu"
    assert client.patch(url, json={"name": ""}, headers=AUTH).status_code == 422

    assert client.delete(url).status_code == 401
    assert client.delete(url, headers=AUTH).status_code == 204
    assert client.get(url).status_code == 404
    assert client.get(f"{url}/file").status_code == 404
    assert client.delete(url, headers=AUTH).status_code == 404


def test_default_model_is_protected(client):
    assert client.delete("/api/models/default", headers=AUTH).status_code == 400
    assert client.patch("/api/models/default", json={"name": "x"}, headers=AUTH).status_code == 400


@pytest.mark.parametrize("model_id", ["../../etc/passwd", "..%2F..%2Fapp", "abc", "A" * 32])
def test_invalid_ids_do_not_touch_filesystem(client, model_id):
    assert client.get(f"/api/models/{model_id}/file").status_code == 404
    assert client.delete(f"/api/models/{model_id}", headers=AUTH).status_code in (404, 405)


def test_bundled_character_is_humanoid():
    info = inspect_file(ROOT_DIR / "frontend" / "assets" / "models" / "character.glb", "glb")
    assert info.humanoid, info.missing_bones
    assert "Idle" in info.animations


def test_non_humanoid_rig_is_reported():
    info = inspect_bytes(make_glb(gltf_json(bones=["Bone", "Bone.001"])), "glb")
    assert info.humanoid is False
    assert "hips" in info.missing_bones


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("mixamorig:LeftUpLeg", "lupleg"),
        ("mixamorigRightForeArm", "rforearm"),
        ("J_Bip_L_UpperLeg", "lupperleg"),
        ("J_Bip_C_Hips", "hips"),
        ("DEF-thigh.L", "lthigh"),
        ("Bip01 R Calf", "rcalf"),
        ("Armature|Head", "head"),
    ],
)
def test_bone_name_normalization(raw, expected):
    assert normalize_bone(raw) == expected


def test_model_error_type():
    with pytest.raises(ModelError):
        inspect_bytes(b"xx", "obj")


def test_static_frontend_still_served(client):
    assert client.get("/js/main.js").status_code == 200
    assert client.get("/../app/main.py").status_code == 404
    assert client.get("/api/unknown").status_code == 404
    assert Path(ROOT_DIR / "frontend" / "index.html").is_file()
