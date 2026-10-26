"""Validate uploaded glTF 2.0 / GLB / VRM files without loading geometry.

Humanoid detection mirrors frontend/js/humanoid-map.js: Mixamo, VRM, Unreal mannequin,
3ds Max Biped (any Bip number, separators space / dash / underscore). Matching follows
the node hierarchy when parent links exist (legs under the hips, arms under the spine,
head under the neck). Twist / IK / socket / prop / end bones and copies such as
root_foot are never candidates. Unmapped secondary bones (hair, skirts, accessories)
are left on their parent; this inspector never invents physics for them.
"""

from __future__ import annotations

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

PHYSICS_REQUIRED = (
    "hips",
    "head",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
)

_PREFIX_TOKEN = re.compile(r"^(mixamorig\d*|armature|def|org|bip\d*|j|c|bip|cc|base|valve|biped|character\d*)$")
_HELPER_TOKEN = re.compile(
    r"^(avg|push|socket|weapon|prop|end|nub|footsteps?|ik|"
    r"ik(foot|hand|leg|arm|knee|elbow|root|target|pole)\w*|"
    r"\w*(foot|hand|leg|arm)ik)\d*$"
)
_HELPER_PART = re.compile(r"twist|socket|weapon")
_LIMB_TOKEN = re.compile(r"^(foot|hand|leg|arm)$")

_SIDED = {
    "Shoulder": re.compile(r"^(shoulder|clavicle|collar(bone)?)$"),
    "UpperArm": re.compile(r"^(arm|upperarm|uparm)$"),
    "LowerArm": re.compile(r"^(forearm|lowerarm|elbow)$"),
    "Hand": re.compile(r"^(hand|wrist)$"),
    "UpperLeg": re.compile(r"^(upleg|upperleg|thigh)$"),
    "LowerLeg": re.compile(r"^(leg|lowerleg|calf|shin|knee)$"),
    "Foot": re.compile(r"^(foot|ankle)$"),
    "Toes": re.compile(r"^(toebase|toes?\d*|ball)$"),
}
_CENTER = {
    "hips": re.compile(r"^(hips?|pelvis)$"),
    "neck": re.compile(r"^neck\d*$"),
    "head": re.compile(r"^head$"),
    "chest": re.compile(r"^chest$"),
    "upperChest": re.compile(r"^upperchest$"),
}
_SPINE_CHAIN = re.compile(r"^(spine\d*|chest|upperchest)$")


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


@dataclass(eq=False)
class _Node:
    name: str
    parent: _Node | None = None


def tokenize(name: str) -> list[str]:
    text = re.split(r"[|:]", name)[-1]
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return [t for t in re.split(r"[\s_.\-]+", text.lower()) if t]


def normalize_bone(name: str) -> str:
    """'mixamorig:LeftUpLeg' -> 'lupleg', 'Bip001-L-Calf' -> 'lcalf', 'thigh.L' -> 'lthigh'."""
    side = ""
    rest = []
    for token in tokenize(name):
        if token in ("l", "left"):
            side = "l"
        elif token in ("r", "right"):
            side = "r"
        elif _PREFIX_TOKEN.match(token):
            continue
        else:
            rest.append(token)
    return side + "".join(rest)


def is_helper_bone(name: str) -> bool:
    tokens = tokenize(name)
    if any(_HELPER_TOKEN.match(t) or _HELPER_PART.search(t) for t in tokens):
        return True
    return "root" in tokens and any(_LIMB_TOKEN.match(t) for t in tokens)


def _depth(node: _Node) -> int:
    depth = 0
    p = node.parent
    while p:
        depth += 1
        p = p.parent
    return depth


def _is_ancestor(ancestor: _Node | None, node: _Node | None) -> bool:
    p = node.parent if node else None
    while p:
        if p is ancestor:
            return True
        p = p.parent
    return False


def _under_helper(node: _Node, helpers: set[_Node]) -> bool:
    p = node
    while p:
        if p in helpers:
            return True
        p = p.parent
    return False


def map_humanoid_nodes(raw_nodes: list[dict]) -> tuple[dict[str, str], list[str]]:
    """Map glTF nodes (with optional `children`) to VRM humanoid keys.

    Returns (mapped name-by-key, missing required keys). Used by inspect and tests.
    """
    nodes = [_Node(str(n.get("name") or "")) for n in raw_nodes]
    for index, raw in enumerate(raw_nodes):
        for child in raw.get("children") or []:
            if isinstance(child, int) and 0 <= child < len(nodes):
                nodes[child].parent = nodes[index]

    named = [n for n in nodes if n.name]
    helpers = {n for n in named if is_helper_bone(n.name)}
    named_set = set(named)
    entries = sorted(
        ((n, normalize_bone(n.name)) for n in named if not _under_helper(n, helpers)),
        key=lambda item: _depth(item[0]),
    )
    linked = any(n.parent in named_set for n, _ in entries)

    def under(anc: _Node | None, node: _Node) -> bool:
        return (not linked) or anc is None or _is_ancestor(anc, node)

    def find(predicate, *ancestors: _Node | None) -> _Node | None:
        ancs = [a for a in ancestors if a is not None] if ancestors else []
        if not ancs:
            ancs = [None]
        for anc in ancs:
            for node, key in entries:
                if predicate(key) and under(anc, node):
                    return node
        return None

    def center(kind: str):
        pattern = _CENTER[kind]
        return lambda key: bool(pattern.match(key))

    def sided(side: str, part: str):
        pattern = _SIDED[part]
        return lambda key: key[:1] == side and bool(pattern.match(key[1:]))

    result: dict[str, _Node] = {}

    def set_key(key: str, node: _Node | None) -> None:
        if node:
            result[key] = node

    set_key("hips", find(center("hips")))
    hips = result.get("hips")
    set_key("neck", find(center("neck"), hips) if hips else find(center("neck")))
    set_key("head", find(center("head"), result.get("neck") or hips) if (result.get("neck") or hips) else find(center("head")))

    top = result.get("neck") or result.get("head")
    chain = [
        (node, key)
        for node, key in entries
        if _SPINE_CHAIN.match(key) and under(hips, node) and ((not linked) or top is None or _is_ancestor(node, top))
    ]
    if chain:
        by_name = {key: node for node, key in chain}
        set_key("chest", by_name.get("chest"))
        set_key("upperChest", by_name.get("upperchest"))
        result["spine"] = chain[0][0]
        rest = [node for node, key in chain[1:] if node is not result.get("chest") and node is not result.get("upperChest")]
        if "chest" not in result and rest:
            result["chest"] = rest.pop(0)
        if "upperChest" not in result and rest:
            result["upperChest"] = rest[-1]
        if result.get("chest") is result.get("spine"):
            result.pop("chest", None)
    torso = result.get("spine") or hips

    for side, letter in (("left", "l"), ("right", "r")):
        def take(part: str, *anc):
            set_key(f"{side}{part}", find(sided(letter, part), *anc))

        take("UpperLeg", hips)
        upper_leg = result.get(f"{side}UpperLeg")
        if upper_leg:
            take("LowerLeg", upper_leg)
        lower_leg = result.get(f"{side}LowerLeg")
        if lower_leg:
            take("Foot", lower_leg)
        foot = result.get(f"{side}Foot")
        if foot:
            take("Toes", foot)

        take("Shoulder", torso)
        take("UpperArm", result.get(f"{side}Shoulder"), torso)
        upper_arm = result.get(f"{side}UpperArm")
        if upper_arm:
            take("LowerArm", upper_arm)
        lower_arm = result.get(f"{side}LowerArm")
        if lower_arm:
            take("Hand", lower_arm)

    if linked and "head" in result and hips and not _is_ancestor(hips, result["head"]):
        result.pop("head", None)

    names = {key: node.name for key, node in result.items()}
    missing = [key for key in PHYSICS_REQUIRED if key not in names]
    if "spine" not in names and "chest" not in names:
        missing.insert(1, "spine")
    return names, missing


def _humanoid_from_gltf(raw_nodes: list[dict], vrm_version: str | None) -> tuple[bool, list[str]]:
    if vrm_version:
        return True, []
    _mapped, missing = map_humanoid_nodes(raw_nodes)
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
    humanoid, missing = _humanoid_from_gltf(nodes, vrm_version)
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
