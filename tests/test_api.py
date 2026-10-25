from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_version():
    response = client.get("/api/version")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Nova"
    assert "version" in body
    assert "git_commit" in body


def test_index_html():
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Nova" in response.text
    assert "immersive-ar" in response.text


def test_character_model_served():
    response = client.get("/assets/models/character.glb")
    assert response.status_code == 200
    assert len(response.content) > 1000


def test_main_js_served():
    response = client.get("/js/main.js")
    assert response.status_code == 200
    assert "startImmersiveAR" in response.text


def test_unknown_path_404():
    response = client.get("/does-not-exist-xyz")
    assert response.status_code == 404
