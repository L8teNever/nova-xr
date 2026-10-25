"""Validate uploaded glTF 2.0 / GLB / VRM files without loading geometry."""

import io
import json
import re
import struct
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import BinaryIO

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A

FORMATS = ("glb", "gltf", "vrm")
EXTENSIONS = {".glb": "glb", ".gltf": "gltf", ".vrm": "vrm"}
VRM_EXTENSIONS = {"VRM": "0.x", "VRMC_vrm": "1.0"}

# Required humanoid bones for physics; same idea as frontend/js/humanoid-map.js.
_REQUIRED = {
    "hips": re.compile(r"^(hips?|pelvis|root)$"),
    "spine": re.compile(r"^(spine\d*|chest|upperchest|torso)$"),
    "head": re.compile(r"^head$"),
    "leftUpperLeg": re.compile(r"^l(upleg|upperleg|thigh)$"),
    "rightUpperLeg": re.compile(r"^r(upleg|upperleg|thigh)$"),
    "leftLowerLeg": re.compile(r"^l(leg|lowerleg|calf|shin|knee)$"),
    "rightLowerLeg": re.compile(r"^r(leg|lowerleg|calf|shin|knee)$"),
    "leftFoot": re.compile(r"^l(foot|ankle)$"),
    "rightFoot": re.compile(r"^r(foot|ankle)$"),
}
_PREFIX_TOKEN = re.compile(r"^(mixamorig\d*|armature|def|org|bip\d*|j|c|bip|cc|base|valve|biped|character\d*)$")


class ModelError(ValueError):
    pass


@dataclass
class ModelInfo:
    format: str
    vrm_version: str | None = None
    meshes: int = 0
    skins: int = 0
    joints: int = 0
    animations: list[str] = field(default_factory=list)
    humanoid: bool = False
    missing_bones: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def normalize_bone(name: str) -> str:
    """'mixamorig:LeftUpLeg' -> 'lupleg', 'J_Bip_R_LowerLeg' -> 'rlowerleg', 'thigh.L' -> 'lthigh'."""
    text = re.split(r"[|:]", name)[-1]
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    tokens = [t for t in re.split(r"[\s_.\-]+", text.lower()) if t]
    side = ""
    rest = []
    for token in tokens:
        if token in ("l", "left"):
            side = "l"
        elif token in ("r", "right"):
            side = "r"
        elif _PREFIX_TOKEN.match(token):
            continue
        else:
            rest.append(token)
    return side + "".join(rest)


def _humanoid(node_names: list[str], vrm_version: str | None) -> tuple[bool, list[str]]:
    if vrm_version:
        return True, []
    normalized = [normalize_bone(name) for name in node_names if name]
    missing = [key for key, pattern in _REQUIRED.items() if not any(pattern.search(n) for n in normalized)]
    return not missing, missing


def _parse_glb(handle: BinaryIO, total_size: int) -> dict:
    header = handle.read(20)
    if len(header) < 20:
        raise ModelError("Datei zu klein für GLB.")
    magic, version, length, chunk_len, chunk_type = struct.unpack("<IIIII", header)
    if magic != GLB_MAGIC:
        raise ModelError("Keine GLB-Datei (Magic 'glTF' fehlt).")
    if version != 2:
        raise ModelError(f"Nur glTF 2.0 wird unterstützt (GLB-Version {version}).")
    if length != total_size:
        raise ModelError("GLB-Länge stimmt nicht mit der Dateigröße überein.")
    if chunk_type != CHUNK_JSON or 20 + chunk_len > total_size:
        raise ModelError("Erster GLB-Chunk ist kein gültiger JSON-Chunk.")
    try:
        return json.loads(handle.read(chunk_len).rstrip(b" \x00").decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelError("GLB-JSON ist ungültig.") from exc


def _parse_gltf(data: bytes) -> dict:
    try:
        gltf = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelError("glTF-Datei ist kein gültiges JSON.") from exc
    for kind in ("buffers", "images"):
        for item in gltf.get(kind) or []:
            uri = item.get("uri") if isinstance(item, dict) else None
            if uri and not uri.startswith("data:"):
                raise ModelError(
                    "Diese .gltf-Datei verweist auf externe Dateien. "
                    "Bitte als .glb exportieren oder alle Daten einbetten."
                )
    return gltf


def inspect_bytes(data: bytes, fmt: str) -> ModelInfo:
    return inspect_stream(io.BytesIO(data), len(data), fmt)


def inspect_file(path: Path, fmt: str) -> ModelInfo:
    with open(path, "rb") as handle:
        return inspect_stream(handle, path.stat().st_size, fmt)


def inspect_stream(handle: BinaryIO, total_size: int, fmt: str) -> ModelInfo:
    if fmt not in FORMATS:
        raise ModelError("Dateityp nicht erlaubt (nur .glb, .gltf, .vrm).")
    if fmt == "gltf":
        data = handle.read()
        if data[:4] == b"glTF":
            raise ModelError("Binäre GLB-Datei mit Endung .gltf – bitte als .glb hochladen.")
        gltf = _parse_gltf(data)
    else:
        gltf = _parse_glb(handle, total_size)
    if not isinstance(gltf, dict):
        raise ModelError("glTF-JSON muss ein Objekt sein.")

    asset_version = str((gltf.get("asset") or {}).get("version", ""))
    if not asset_version.startswith("2"):
        raise ModelError(f"Nur glTF 2.0 wird unterstützt (asset.version={asset_version or '?'}).")

    extensions = set(gltf.get("extensionsUsed") or []) | set((gltf.get("extensions") or {}).keys())
    vrm_version = next((v for k, v in VRM_EXTENSIONS.items() if k in extensions), None)
    if fmt == "vrm" and not vrm_version:
        raise ModelError("VRM-Datei ohne VRM- bzw. VRMC_vrm-Erweiterung.")
    if fmt != "vrm" and vrm_version:
        fmt = "vrm"

    nodes = [n for n in gltf.get("nodes") or [] if isinstance(n, dict)]
    skins = [s for s in gltf.get("skins") or [] if isinstance(s, dict)]
    joint_ids = {j for skin in skins for j in skin.get("joints") or [] if isinstance(j, int)}
    joint_names = [str(nodes[j].get("name") or "") for j in joint_ids if 0 <= j < len(nodes)]
    humanoid, missing = _humanoid(joint_names or [str(n.get("name") or "") for n in nodes], vrm_version)
    animations = [
        str(clip.get("name") or f"clip-{index}")
        for index, clip in enumerate(gltf.get("animations") or [])
        if isinstance(clip, dict)
    ]
    if not gltf.get("meshes"):
        raise ModelError("Das Modell enthält keine Meshes.")
    return ModelInfo(
        format=fmt,
        vrm_version=vrm_version,
        meshes=len(gltf.get("meshes") or []),
        skins=len(skins),
        joints=len(joint_ids),
        animations=animations,
        humanoid=humanoid and bool(skins),
        missing_bones=missing if skins else ["skin"],
    )
