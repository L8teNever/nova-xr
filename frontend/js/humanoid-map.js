// Maps arbitrary rig bone names (Mixamo, VRM, Rigify, Unreal mannequin, 3ds Max Biped, ...) onto VRM humanoid bone names.
// No three.js import: works on anything with { name, parent, children }.
// Matching follows the hierarchy (legs under the hips, arms under the spine, head under the neck), and helper bones
// (twist, IK, sockets, props, end/nub markers, ...) and everything below them are never candidates.
// Unmapped bones (hair, skirts, accessories, twist bones) simply stay attached to their parent.

export const HUMANOID_BONES = [
  "hips", "spine", "chest", "upperChest", "neck", "head",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
  "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
];

export const PHYSICS_REQUIRED = [
  "hips", "head",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
];

export const BONE_LABELS = {
  hips: "Hüfte/Becken", spine: "Wirbelsäule", chest: "Brustkorb", upperChest: "obere Brust", neck: "Hals", head: "Kopf",
  leftShoulder: "linkes Schlüsselbein", leftUpperArm: "linker Oberarm", leftLowerArm: "linker Unterarm", leftHand: "linke Hand",
  rightShoulder: "rechtes Schlüsselbein", rightUpperArm: "rechter Oberarm", rightLowerArm: "rechter Unterarm", rightHand: "rechte Hand",
  leftUpperLeg: "linker Oberschenkel", leftLowerLeg: "linker Unterschenkel", leftFoot: "linker Fuß", leftToes: "linke Zehen",
  rightUpperLeg: "rechter Oberschenkel", rightLowerLeg: "rechter Unterschenkel", rightFoot: "rechter Fuß", rightToes: "rechte Zehen",
  skin: "Skin (Mesh-Bindung)",
};

/** Human-readable list of missing required bones, e.g. for status lines. */
export function describeMissing(keys) {
  return keys.map((k) => BONE_LABELS[k] || k).join(", ");
}

const PREFIX_TOKEN = /^(mixamorig\d*|armature|def|org|bip\d*|j|c|bip|cc|base|valve|biped|character\d*)$/;

const SIDED = {
  Shoulder: /^(shoulder|clavicle|collar(bone)?)$/,
  UpperArm: /^(arm|upperarm|uparm)$/,
  LowerArm: /^(forearm|lowerarm|elbow)$/,
  Hand: /^(hand|wrist)$/,
  UpperLeg: /^(upleg|upperleg|thigh)$/,
  LowerLeg: /^(leg|lowerleg|calf|shin|knee)$/,
  Foot: /^(foot|ankle)$/,
  Toes: /^(toebase|toes?\d*|ball)$/,
};

const CENTER = {
  hips: /^(hips?|pelvis)$/,
  neck: /^neck\d*$/,
  head: /^head$/,
  chest: /^chest$/,
  upperChest: /^upperchest$/,
};
const SPINE_CHAIN = /^(spine\d*|chest|upperchest)$/;

const HELPER_TOKEN = /^(avg|push|socket|weapon|prop|end|nub|footsteps?|ik|ik(foot|hand|leg|arm|knee|elbow|root|target|pole)\w*|\w*(foot|hand|leg|arm)ik)\d*$/;
const HELPER_PART = /twist|socket|weapon/;
const LIMB_TOKEN = /^(foot|hand|leg|arm)$/;

const FINGER_TYPES = ["Thumb", "Index", "Middle", "Ring", "Little"];
const FINGER_SEGMENTS = {
  Thumb: ["Metacarpal", "Proximal", "Distal"],
  Index: ["Proximal", "Intermediate", "Distal"],
  Middle: ["Proximal", "Intermediate", "Distal"],
  Ring: ["Proximal", "Intermediate", "Distal"],
  Little: ["Proximal", "Intermediate", "Distal"],
};
const FINGER_NAME = /^(?:hand|f)?(thumb|index|middle|ring|pinky|little)(?:finger)?\d*$/;
const BIPED_FINGER = /^finger([0-4])\d*$/;

function tokenize(name) {
  const text = String(name || "").split(/[|:]/).pop().replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return text.toLowerCase().split(/[\s_.\-]+/).filter(Boolean);
}

/** 'mixamorig:LeftUpLeg' -> 'lupleg', 'J_Bip_R_LowerLeg' -> 'rlowerleg', 'thigh.L' -> 'lthigh', 'Bip001-L-Calf' -> 'lcalf'. */
export function normalizeBoneName(name) {
  let side = "";
  const rest = [];
  for (const token of tokenize(name)) {
    if (token === "l" || token === "left") side = "l";
    else if (token === "r" || token === "right") side = "r";
    else if (!PREFIX_TOKEN.test(token)) rest.push(token);
  }
  return side + rest.join("");
}

/** Twist/IK/socket/prop/end bones and copies such as 'root_foot' that must never stand in for a body bone. */
export function isHelperBoneName(name) {
  const tokens = tokenize(name);
  if (tokens.some((t) => HELPER_TOKEN.test(t) || HELPER_PART.test(t))) return true;
  return tokens.includes("root") && tokens.some((t) => LIMB_TOKEN.test(t));
}

function depthOf(node) {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent) depth += 1;
  return depth;
}

function isAncestor(ancestor, node) {
  for (let p = node?.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

function underHelper(bone, helpers) {
  for (let p = bone; p; p = p.parent) if (helpers.has(p)) return true;
  return false;
}

/**
 * @param {Array<{name:string,parent?:object}>} bones
 * @returns {{ bones: Record<string, object>, fingers: Record<string, object>, missing: string[], missingRequired: string[],
 *   physicsReady: boolean, ignored: string[], source: string }}
 */
export function mapHumanoid(bones) {
  const named = bones.filter((b) => b && b.name);
  const helpers = new Set(named.filter((b) => isHelperBoneName(b.name)));
  const ignored = named.filter((b) => underHelper(b, helpers));
  const ignoredSet = new Set(ignored);
  const namedSet = new Set(named);
  const entries = named
    .filter((b) => !ignoredSet.has(b))
    .map((bone) => ({ bone, key: normalizeBoneName(bone.name), depth: depthOf(bone) }))
    .sort((a, b) => a.depth - b.depth);
  const linked = entries.some((e) => e.bone.parent && namedSet.has(e.bone.parent));
  const under = (anc, bone) => !linked || !anc || isAncestor(anc, bone);

  const find = (pattern, ...ancestors) => {
    for (const anc of ancestors) {
      if (anc === undefined) continue;
      const hit = entries.find((e) => pattern(e.key) && under(anc, e.bone));
      if (hit) return hit.bone;
    }
    return undefined;
  };
  const center = (key) => (k) => CENTER[key].test(k);
  const sided = (s, part) => (k) => k[0] === s && SIDED[part].test(k.slice(1));

  const result = {};
  const set = (key, bone) => bone && (result[key] = bone);
  set("hips", find(center("hips"), null));
  const hips = result.hips || null;
  set("neck", find(center("neck"), hips));
  set("head", find(center("head"), result.neck || hips));

  const top = result.neck || result.head;
  const chain = entries.filter(
    (e) => SPINE_CHAIN.test(e.key) && under(hips, e.bone) && (!linked || !top || isAncestor(e.bone, top)),
  );
  if (chain.length) {
    const byName = (name) => chain.find((e) => e.key === name)?.bone;
    set("chest", byName("chest"));
    set("upperChest", byName("upperchest"));
    result.spine = chain[0].bone;
    const rest = chain.slice(1).filter((e) => e.bone !== result.chest && e.bone !== result.upperChest);
    if (!result.chest && rest.length) result.chest = rest.shift().bone;
    if (!result.upperChest && rest.length) result.upperChest = rest[rest.length - 1].bone;
    if (result.chest === result.spine) delete result.chest;
  }
  const torso = result.spine || hips;

  for (const side of ["left", "right"]) {
    const s = side[0];
    const S = (part) => result[side + part];
    set(`${side}UpperLeg`, find(sided(s, "UpperLeg"), hips));
    if (S("UpperLeg")) set(`${side}LowerLeg`, find(sided(s, "LowerLeg"), S("UpperLeg")));
    if (S("LowerLeg")) set(`${side}Foot`, find(sided(s, "Foot"), S("LowerLeg")));
    if (S("Foot")) set(`${side}Toes`, find(sided(s, "Toes"), S("Foot")));

    set(`${side}Shoulder`, find(sided(s, "Shoulder"), torso));
    set(`${side}UpperArm`, find(sided(s, "UpperArm"), S("Shoulder"), torso));
    if (S("UpperArm")) set(`${side}LowerArm`, find(sided(s, "LowerArm"), S("UpperArm")));
    if (S("LowerArm")) set(`${side}Hand`, find(sided(s, "Hand"), S("LowerArm")));
  }
  if (linked && result.head && hips && !isAncestor(hips, result.head)) delete result.head;

  const fingers = linked ? mapFingers(entries, result) : {};
  const missing = HUMANOID_BONES.filter((k) => !result[k]);
  const missingRequired = requiredMissing(result);
  return { bones: result, fingers, missing, missingRequired, physicsReady: missingRequired.length === 0, ignored: ignored.map((b) => b.name), source: "names" };
}

function requiredMissing(result) {
  const missing = PHYSICS_REQUIRED.filter((k) => !result[k]);
  if (!result.spine && !result.chest) missing.splice(1, 0, "spine");
  return missing;
}

/** Finger chains below each hand, named like VRM 1.0 (leftThumbMetacarpal, leftIndexProximal, ...). Informational only. */
function mapFingers(entries, result) {
  const fingers = {};
  for (const side of ["left", "right"]) {
    const hand = result[`${side}Hand`];
    if (!hand) continue;
    const groups = new Map();
    for (const e of entries) {
      if (!isAncestor(hand, e.bone)) continue;
      const key = e.key[0] === side[0] ? e.key.slice(1) : e.key;
      let type = null;
      const named = FINGER_NAME.exec(key);
      if (named) type = named[1] === "pinky" ? "Little" : named[1][0].toUpperCase() + named[1].slice(1);
      const biped = !type && BIPED_FINGER.exec(key);
      if (biped) type = FINGER_TYPES[Number(biped[1])];
      if (!type) continue;
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(e.bone);
    }
    for (const [type, list] of groups) {
      const segs = FINGER_SEGMENTS[type];
      let prev = hand;
      let index = 0;
      for (const bone of list) {
        if (index >= segs.length) break;
        if (!isAncestor(prev, bone)) continue;
        fingers[`${side}${type}${segs[index++]}`] = bone;
        prev = bone;
      }
    }
  }
  return fingers;
}

/** VRM files carry an explicit humanoid map; prefer it over name heuristics. */
export function mapFromVrm(vrm) {
  const result = {};
  for (const key of HUMANOID_BONES) {
    const node = vrm.humanoid?.getRawBoneNode?.(key);
    if (node) result[key] = node;
  }
  const fingers = {};
  for (const side of ["left", "right"]) {
    for (const type of FINGER_TYPES) {
      for (const seg of FINGER_SEGMENTS[type]) {
        const node = vrm.humanoid?.getRawBoneNode?.(`${side}${type}${seg}`);
        if (node) fingers[`${side}${type}${seg}`] = node;
      }
    }
  }
  const missing = HUMANOID_BONES.filter((k) => !result[k]);
  const missingRequired = requiredMissing(result);
  return { bones: result, fingers, missing, missingRequired, physicsReady: missingRequired.length === 0, ignored: [], source: "vrm" };
}
