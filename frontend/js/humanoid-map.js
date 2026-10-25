// Maps arbitrary rig bone names (Mixamo, VRM, Rigify, Unreal, Biped, ...) onto VRM humanoid bone names.
// No three.js import: works on anything with { name, parent, children }.

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

/** 'mixamorig:LeftUpLeg' -> 'lupleg', 'J_Bip_R_LowerLeg' -> 'rlowerleg', 'thigh.L' -> 'lthigh'. */
export function normalizeBoneName(name) {
  let text = String(name || "").split(/[|:]/).pop();
  text = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  let side = "";
  const rest = [];
  for (const token of text.toLowerCase().split(/[\s_.\-]+/)) {
    if (!token) continue;
    if (token === "l" || token === "left") side = "l";
    else if (token === "r" || token === "right") side = "r";
    else if (!PREFIX_TOKEN.test(token)) rest.push(token);
  }
  return side + rest.join("");
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

/**
 * @param {Array<{name:string,parent?:object}>} bones
 * @returns {{ bones: Record<string, object>, missing: string[], physicsReady: boolean, source: string }}
 */
export function mapHumanoid(bones) {
  const entries = bones
    .filter((b) => b && b.name)
    .map((bone) => ({ bone, key: normalizeBoneName(bone.name), depth: depthOf(bone) }))
    .sort((a, b) => a.depth - b.depth);

  const result = {};
  const take = (humanKey, predicate) => {
    if (result[humanKey]) return;
    const hit = entries.find((e) => predicate(e));
    if (hit) result[humanKey] = hit.bone;
  };

  for (const [humanKey, pattern] of Object.entries(CENTER)) take(humanKey, (e) => pattern.test(e.key));

  const below = (anc) => (e) => !anc || isAncestor(anc, e.bone);
  for (const side of ["left", "right"]) {
    const s = side[0];
    for (const [suffix, pattern] of Object.entries(SIDED)) {
      take(side + suffix, (e) => e.key[0] === s && pattern.test(e.key.slice(1)) && below(result.hips)(e));
    }
  }

  // Spine chain between hips and neck/head: first is "spine", then chest, upperChest.
  const top = result.neck || result.head;
  const chain = entries.filter(
    (e) => SPINE_CHAIN.test(e.key) && (!result.hips || isAncestor(result.hips, e.bone)) && (!top || isAncestor(e.bone, top)),
  );
  if (chain.length) {
    result.spine = chain[0].bone;
    const rest = chain.slice(1).filter((e) => e.bone !== result.chest && e.bone !== result.upperChest);
    if (!result.chest && rest.length) result.chest = rest.shift().bone;
    if (!result.upperChest && rest.length) result.upperChest = rest[rest.length - 1].bone;
  }
  if (result.chest === result.spine) delete result.chest;

  dropBrokenChains(result);

  const missing = HUMANOID_BONES.filter((k) => !result[k]);
  const physicsReady = PHYSICS_REQUIRED.every((k) => result[k]) && Boolean(result.spine || result.chest);
  return { bones: result, missing, physicsReady, source: "names" };
}

function dropBrokenChains(result) {
  const chains = [
    ["hips", "UpperLeg", "LowerLeg", "Foot", "Toes"],
    ["hips", "UpperArm", "LowerArm", "Hand"],
  ];
  for (const side of ["left", "right"]) {
    for (const chain of chains) {
      let prev = result[chain[0]];
      for (const part of chain.slice(1)) {
        const key = side + part;
        if (!result[key]) break;
        if (prev && !isAncestor(prev, result[key])) {
          for (const later of chain.slice(chain.indexOf(part))) delete result[side + later];
          break;
        }
        prev = result[key];
      }
    }
  }
  if (result.head && result.hips && !isAncestor(result.hips, result.head)) delete result.head;
}

/** VRM files carry an explicit humanoid map; prefer it over name heuristics. */
export function mapFromVrm(vrm) {
  const result = {};
  for (const key of HUMANOID_BONES) {
    const node = vrm.humanoid?.getRawBoneNode?.(key);
    if (node) result[key] = node;
  }
  const missing = HUMANOID_BONES.filter((k) => !result[k]);
  const physicsReady = PHYSICS_REQUIRED.every((k) => result[k]) && Boolean(result.spine || result.chest);
  return { bones: result, missing, physicsReady, source: "vrm" };
}
