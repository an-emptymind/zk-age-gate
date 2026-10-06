/**
 * Shared Merkle machinery, used by build-tree.js (the honest registrar) and by
 * the attack fixtures (a rogue registrar building a tampered registry).
 */
import { buildPoseidon } from "circomlibjs";

export const DEPTH = 4; // 2^4 = 16 leaf slots

export function nameToField(name, p) {
  let acc = 0n;
  for (const byte of Buffer.from(name, "utf8")) acc = (acc * 257n + BigInt(byte)) % p;
  return acc;
}

export function randomSalt() {
  return BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString("hex"));
}

/**
 * @param students  [{ roll, name, class, age }]
 * @param fixedSalt optional - use a deterministic salt so fixtures reproduce
 * @returns { root, bundles: { [roll]: circuitInput }, leaves }
 */
export async function buildTree(students, fixedSalt = null) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (xs) => F.toObject(poseidon(xs));

  const size = 1 << DEPTH;
  if (students.length > size) throw new Error(`depth ${DEPTH} holds only ${size} leaves`);

  const rows = students.map((s) => {
    const fields = {
      name: nameToField(s.name, F.p),
      roll: BigInt(s.roll),
      class: BigInt(s.class),
      age: BigInt(s.age),
      salt: fixedSalt === null ? randomSalt() : BigInt(fixedSalt),
    };
    return {
      ...s,
      fields,
      leaf: H([fields.name, fields.roll, fields.class, fields.age, fields.salt]),
    };
  });

  const EMPTY = H([0n, 0n, 0n, 0n, 0n]);
  const leaves = rows.map((r) => r.leaf);
  while (leaves.length < size) leaves.push(EMPTY);

  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(H([prev[i], prev[i + 1]]));
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];

  const pathFor = (index) => {
    const elements = [];
    const indices = [];
    let idx = index;
    for (let d = 0; d < DEPTH; d++) {
      const isRight = idx & 1;
      elements.push(levels[d][isRight ? idx - 1 : idx + 1].toString());
      indices.push(isRight);
      idx >>= 1;
    }
    return { elements, indices };
  };

  const bundles = {};
  rows.forEach((r, i) => {
    const { elements, indices } = pathFor(i);
    bundles[r.roll] = {
      name: r.fields.name.toString(),
      class: r.fields.class.toString(),
      age: r.fields.age.toString(),
      salt: r.fields.salt.toString(),
      pathElements: elements,
      pathIndices: indices,
      root: root.toString(),
      rollNumber: r.fields.roll.toString(),
      threshold: "18",
    };
  });

  // self-check: every path must rebuild the root
  const verified = rows.filter((r, i) => {
    const { elements, indices } = pathFor(i);
    let cur = r.leaf;
    for (let d = 0; d < DEPTH; d++) {
      const sib = BigInt(elements[d]);
      cur = indices[d] ? H([sib, cur]) : H([cur, sib]);
    }
    return cur === root;
  }).length;

  return { root, bundles, rows, verified, size };
}
