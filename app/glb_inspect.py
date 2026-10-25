import json
import struct
from dataclasses import dataclass

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A


@dataclass
class GlbInfo:
    mesh_count: int
    skin_count: int
    joint_count: int
    animation_names: list[str]
    node_names: list[str]

    @property
    def rigged(self) -> bool:
        return self.skin_count > 0 or self.joint_count > 0

    @property
    def animated(self) -> bool:
        return len(self.animation_names) > 0


class GlbError(ValueError):
    pass


def inspect_glb(data: bytes) -> GlbInfo:
    if len(data) < 12:
        raise GlbError("Datei zu klein für GLB.")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise GlbError("Keine GLB-Datei (glTF binary).")
    if version != 2:
        raise GlbError(f"Nur glTF 2.0 wird unterstützt (Version {version}).")
    if length > len(data):
        raise GlbError("GLB-Länge ungültig.")

    offset = 12
    gltf: dict | None = None
    while offset + 8 <= len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_len]
        offset += chunk_len
        if chunk_type == CHUNK_JSON:
            text = chunk.split(b"\x00", 1)[0].decode("utf-8")
            gltf = json.loads(text)
            break
    if not isinstance(gltf, dict):
        raise GlbError("Kein JSON-Chunk in der GLB.")

    skins = gltf.get("skins") or []
    joints = []
    for skin in skins:
        joints.extend(skin.get("joints") or [])
    animations = gltf.get("animations") or []
    names = []
    for index, clip in enumerate(animations):
        names.append(str(clip.get("name") or f"clip-{index}"))
    nodes = gltf.get("nodes") or []
    return GlbInfo(
        mesh_count=len(gltf.get("meshes") or []),
        skin_count=len(skins),
        joint_count=len(set(joints)),
        animation_names=names,
        node_names=[str(node.get("name") or "") for node in nodes if isinstance(node, dict)],
    )
