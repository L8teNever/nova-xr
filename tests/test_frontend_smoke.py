from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


def test_required_frontend_files_exist():
    required = [
        FRONTEND / "index.html",
        FRONTEND / "css" / "style.css",
        FRONTEND / "js" / "main.js",
        FRONTEND / "js" / "scene.js",
        FRONTEND / "js" / "character.js",
        FRONTEND / "js" / "physics.js",
        FRONTEND / "js" / "xr-session.js",
        FRONTEND / "assets" / "models" / "character.glb",
        FRONTEND / "assets" / "models" / "LICENSE.txt",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    assert not missing, f"Fehlende Dateien: {missing}"


def test_webxr_feature_flags_documented():
    source = (FRONTEND / "js" / "xr-session.js").read_text(encoding="utf-8")
    for flag in (
        "plane-detection",
        "mesh-detection",
        "hit-test",
        "anchors",
        "hand-tracking",
    ):
        assert flag in source


def test_modes_present():
    main = (FRONTEND / "js" / "main.js").read_text(encoding="utf-8")
    assert "place" in main
    assert "interact" in main
    assert "ragdoll" in main.lower() or "setMode" in main


def test_no_sexualized_content_markers():
    html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    assert "nsfw" not in html.lower()


def test_public_url_is_placeholder_only():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    assert "PUBLIC_URL=https://example.com" in example
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "${PUBLIC_URL}" in readme or "PUBLIC_URL" in readme
    assert "example.com" in readme
