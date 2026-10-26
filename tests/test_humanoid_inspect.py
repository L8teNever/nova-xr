"""Backend humanoid inspection for synthetic Biped and Unreal-mannequin skeletons."""

import pytest

from app.model_inspect import inspect_bytes, is_helper_bone, map_humanoid_nodes, normalize_bone
from tests.rig_gltf import load_rig_fixture, make_glb, rig_to_gltf


def _mapped(fixture: dict) -> tuple[dict[str, str], list[str]]:
    return map_humanoid_nodes(rig_to_gltf(fixture)["nodes"])


@pytest.mark.parametrize("filename", ["biped.json", "ue-mannequin.json"])
def test_synthetic_rigs_are_humanoid(filename):
    fixture = load_rig_fixture(filename)
    mapped, missing = _mapped(fixture)
    assert missing == []
    for key, name in fixture["expect"].items():
        assert mapped[key] == name, key
    for name in fixture["helpers"]:
        assert name not in mapped.values(), name
    for name in fixture["unmapped"]:
        assert name not in mapped.values(), name
    info = inspect_bytes(make_glb(rig_to_gltf(fixture)), "glb")
    assert info.humanoid is True
    assert info.missing_bones == []


def test_biped_pelvis_is_hips_not_the_bip_root():
    mapped, missing = _mapped(load_rig_fixture("biped.json"))
    assert missing == []
    assert mapped["hips"] == "Bip001 Pelvis"
    assert mapped["leftFoot"] == "Bip001 L Foot"
    assert "Bip001" not in mapped.values()


def test_ue_ik_foot_copy_is_not_mapped_as_the_foot():
    fixture = load_rig_fixture("ue-mannequin.json")
    mapped, missing = _mapped(fixture)
    assert missing == []
    assert mapped["leftFoot"] == "foot_l"
    assert mapped["leftHand"] == "hand_l"
    assert mapped["leftToes"] == "ball_l"
    assert "ik_foot_l" not in mapped.values()
    assert "foot_l_IK" not in mapped.values()
    assert "root_hand" not in mapped.values()
    nodes = rig_to_gltf(fixture)["nodes"]
    first_hand = next(i for i, n in enumerate(nodes) if n.get("name") == "hand_l")
    parent = next(n["name"] for n in nodes if first_hand in (n.get("children") or []))
    assert parent == "lowerarm_l"


def test_helper_and_biped_name_variants():
    assert is_helper_bone("upperarm_twist_01_l")
    assert is_helper_bone("Bip001 L ForeTwist")
    assert is_helper_bone("ik_foot_l")
    assert is_helper_bone("foot_l_IK")
    assert is_helper_bone("root_foot")
    assert is_helper_bone("Bip001 Footsteps")
    assert is_helper_bone("weapon_r")
    assert is_helper_bone("HeadTop_End")
    assert not is_helper_bone("Bip001 Pelvis")
    assert not is_helper_bone("hand_l")
    assert not is_helper_bone("spine_03")
    assert normalize_bone("Bip001-L-Thigh") == "lthigh"
    assert normalize_bone("Bip01_R_Toe0") == "rtoe0"
    assert normalize_bone("Bip002 L Calf") == "lcalf"
    assert normalize_bone("upperarm_l") == "lupperarm"
    assert normalize_bone("Bip001") == ""


def test_flat_mixamo_names_still_count_as_humanoid():
    bones = [
        "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Head",
        "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot",
        "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot",
    ]
    nodes = [{"name": name} for name in bones] + [{"name": "Body", "mesh": 0, "skin": 0}]
    doc = {
        "asset": {"version": "2.0"},
        "nodes": nodes,
        "meshes": [{"primitives": [{"attributes": {}}]}],
        "skins": [{"joints": list(range(len(bones)))}],
    }
    info = inspect_bytes(make_glb(doc), "glb")
    assert info.humanoid is True
    assert info.missing_bones == []


def test_missing_required_bones_are_listed():
    fixture = load_rig_fixture("ue-mannequin.json")
    skip = {"calf_r", "foot_r", "ball_r", "calf_twist_01_r"}
    fixture = {**fixture, "bones": [row for row in fixture["bones"] if row[0] not in skip]}
    _mapped_names, missing = _mapped(fixture)
    assert "rightLowerLeg" in missing
    assert "rightFoot" in missing
    info = inspect_bytes(make_glb(rig_to_gltf(fixture)), "glb")
    assert info.humanoid is False
    assert "rightLowerLeg" in info.missing_bones
    assert "rightFoot" in info.missing_bones


def test_biped_separator_variants_inspect_as_humanoid():
    fixture = load_rig_fixture("biped.json")
    for prefix in ("Bip001", "Bip01", "Bip002"):
        for sep in (" ", "-", "_"):
            def rename(name, prefix=prefix, sep=sep):
                return name.replace("Bip001", prefix, 1).replace(" ", sep) if name.startswith("Bip001") else name

            variant = {**fixture, "bones": [[rename(n), p if p is None else rename(p), x, y, z] for n, p, x, y, z in fixture["bones"]]}
            info = inspect_bytes(make_glb(rig_to_gltf(variant)), "glb")
            assert info.humanoid is True, f"{prefix!r} {sep!r}: {info.missing_bones}"
