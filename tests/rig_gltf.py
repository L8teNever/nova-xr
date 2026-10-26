"""Build a minimal glTF document from a hand-written skeleton fixture (no external models)."""

from __future__ import annotations

import json
import struct
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "rigs"


def load_rig_fixture(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def rig_to_gltf(fixture: dict) -> dict:
    nodes: list[dict] = []
    latest: dict[str, int] = {}
    for name, parent, x, y, z in fixture["bones"]:
        node: dict = {"name": name, "translation": [x, y, z]}
        index = len(nodes)
        if parent is not None:
            parent_index = latest[parent]
            nodes[parent_index].setdefault("children", []).append(index)
        latest[name] = index
        nodes.append(node)
    joints = list(range(len(nodes)))
    return {
        "asset": {"version": "2.0"},
        "nodes": nodes + [{"name": "Body", "mesh": 0, "skin": 0}],
        "meshes": [{"primitives": [{"attributes": {}}]}],
        "skins": [{"joints": joints}],
    }


def make_glb(doc: dict) -> bytes:
    payload = json.dumps(doc).encode()
    payload += b" " * ((4 - len(payload) % 4) % 4)
    chunks = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    return struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks
