/**
 * STUDENT SIDE. Runs on the student's own machine.
 *
 *   node scripts/prove.js 1
 *
 * Reads that student's private bundle and produces a proof that says exactly:
 *   "roll number N is in the college registry and is at least 18"
 * The age, name and class are used to build the proof and then thrown away.
 */
import fs from "fs";
import * as snarkjs from "snarkjs";

const roll = process.argv[2] ?? "1";
const B = "build";

const bundlePath = `${B}/bundles/${roll}.json`;
if (!fs.existsSync(bundlePath)) {
  console.error(`no bundle for roll ${roll} — run 'npm run tree' first`);
  process.exit(1);
}
const input = JSON.parse(fs.readFileSync(bundlePath, "utf8"));

// What the registry actually says about this student — for the demo printout
// only. This information is NOT in the proof.
const registry = JSON.parse(fs.readFileSync("registry/students.json", "utf8"));
const truth = registry.students.find((s) => String(s.roll) === String(roll));

console.log(`\n  proving for roll ${roll}`);
console.log(`  (registry says: ${truth.name}, class ${truth.class}, age ${truth.age})`);

const t0 = Date.now();
let proof, publicSignals;
try {
  ({ proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    `${B}/agegate_js/agegate.wasm`,
    `${B}/agegate_final.zkey`
  ));
} catch (e) {
  console.error(`\n  PROOF REFUSED — the constraint system is unsatisfiable for this student.`);
  console.error(`  age ${truth.age} < threshold ${input.threshold}, so no witness exists.`);
  console.error(`  There is nothing to "try harder" at: an underage student cannot`);
  console.error(`  produce a proof at all, valid or otherwise.\n`);
  process.exit(2);
}
const ms = Date.now() - t0;

fs.writeFileSync(`${B}/proof-${roll}.json`, JSON.stringify(proof, null, 2));
fs.writeFileSync(`${B}/public-${roll}.json`, JSON.stringify(publicSignals, null, 2));

const bytes = fs.statSync(`${B}/proof-${roll}.json`).size;
console.log(`\n  proof generated in ${ms} ms`);
console.log(`  -> ${B}/proof-${roll}.json  (${bytes} bytes as JSON, 256 bytes packed)`);

console.log(`\n  PUBLIC — the provider sees these three numbers:`);
console.log(`    root        ${publicSignals[0]}`);
console.log(`    rollNumber  ${publicSignals[1]}`);
console.log(`    threshold   ${publicSignals[2]}`);

console.log(`\n  PRIVATE — used to build the proof, present nowhere in it:`);
console.log(`    name        ${truth.name}`);
console.log(`    class       ${truth.class}`);
console.log(`    age         ${truth.age}`);
console.log(`    salt, and the Merkle path`);

// Sanity check: no private field may appear as a value in the proof.
//
// This compares whole field elements, not substrings. A substring test is
// meaningless here -- "19" occurs inside almost any 77-digit coordinate by
// chance, which says nothing about leakage.
// Compare against the PROOF POINTS only. Public signals are public by
// definition, and a private value may legitimately coincide with one -- a
// student who is exactly 18 has age == threshold, which reveals nothing,
// because the threshold is the same fixed 18 for every student.
const proofPoints = [...proof.pi_a, ...proof.pi_b.flat(), ...proof.pi_c].map(String);

const secrets = {
  age: input.age,
  salt: input.salt,
  name: input.name,
  class: input.class,
  ...Object.fromEntries(input.pathElements.map((p, i) => [`path[${i}]`, p])),
};
const leaked = Object.entries(secrets).filter(([, v]) => proofPoints.includes(String(v)));

// Separately: nothing unexpected may be public. The circuit declares exactly
// three public signals, so anything else appearing here would be a leak.
const expectedPublic = [input.root, input.rollNumber, input.threshold].map(String);
const publicOk =
  publicSignals.length === 3 && publicSignals.every((v, i) => String(v) === expectedPublic[i]);

console.log(
  `\n  leak check: ${leaked.length === 0
    ? `none of ${Object.keys(secrets).length} private values appears among the ${proofPoints.length} proof points  OK`
    : "LEAKED " + leaked.map(([k]) => k).join(", ")}`
);
console.log(
  `  public set: ${publicOk ? "exactly [root, rollNumber, threshold], nothing else  OK" : "UNEXPECTED public signals"}`
);

const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
fs.writeFileSync(`${B}/calldata-${roll}.txt`, calldata);
console.log(`  calldata  -> ${B}/calldata-${roll}.txt\n`);

process.exit(0);
