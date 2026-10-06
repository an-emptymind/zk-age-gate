/**
 * Off-chain attacks. These all fail at WITNESS GENERATION — the student
 * cannot even build a witness, let alone a proof. That is a stronger
 * guarantee than "the verifier rejects it": there is no artefact to reject.
 *
 *   node scripts/attack.js
 */
import fs from "fs";
import * as snarkjs from "snarkjs";
import { buildTree } from "../registry/tree-lib.js";

const B = "build";
const WASM = `${B}/agegate_js/agegate.wasm`;
const ZKEY = `${B}/agegate_final.zkey`;
const vkey = JSON.parse(fs.readFileSync(`${B}/vkey.json`, "utf8"));
const bundle = (n) => JSON.parse(fs.readFileSync(`${B}/bundles/${n}.json`, "utf8"));

let pass = 0;
let fail = 0;

/**
 * The circom wasm runtime writes its own errors straight to stdout, not via
 * console.log, so both have to be intercepted to keep the report readable.
 */
async function quietProve(input) {
  const realLog = console.log;
  const realErr = console.error;
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  const sink = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  console.log = (...a) => sink(a.join(" "));
  console.error = (...a) => sink(a.join(" "));
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    return { result: await snarkjs.groth16.fullProve(input, WASM, ZKEY), captured };
  } catch (e) {
    e.captured = captured;
    throw e;
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.stdout.write = realWrite;
    process.stderr.write = realErrWrite;
  }
}

/** Pull the circom template + line out of the captured error. */
function blame(captured, err) {
  const text = captured.join("\n") + "\n" + (err?.message ?? "");
  const m = text.match(/Error in template (\w+?)_\d+ line: (\d+)/);
  return m ? `${m[1]}, line ${m[2]}` : "constraint unsatisfied";
}

async function mustFail(label, why, input) {
  process.stdout.write(`  ${label.padEnd(38)}`);
  try {
    await quietProve(input);
    console.log(`PROOF PRODUCED  <-- ATTACK SUCCEEDED, THIS IS A BUG`);
    fail++;
  } catch (e) {
    console.log(`blocked by ${blame(e.captured ?? [], e)}`);
    console.log(`      ${why}\n`);
    pass++;
  }
}

async function mustSucceed(label, why, input) {
  process.stdout.write(`  ${label.padEnd(38)}`);
  try {
    const { result } = await quietProve(input);
    const ok = await snarkjs.groth16.verify(vkey, result.publicSignals, result.proof);
    console.log(ok ? `proof valid` : `PROOF INVALID <-- BUG`);
    console.log(`      ${why}\n`);
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`REFUSED <-- BUG`);
    fail++;
  }
}

console.log(`\n  OFF-CHAIN ATTACKS — all of these should be blocked\n`);

// 1 -----------------------------------------------------------------------
await mustFail(
  "1. underage student proves 18+",
  "roll 9 is 15. The GreaterEqThan constraint has no satisfying assignment.",
  bundle(9)
);

// 2 -----------------------------------------------------------------------
await mustFail(
  "2. edit own age 16 -> 19",
  "changing age changes the leaf hash, so the Merkle path no longer reaches the root.",
  { ...bundle(4), age: "19" }
);

// 3 -----------------------------------------------------------------------
await mustFail(
  "3. borrow an eligible student's path",
  "roll 4's fields under roll 1's path produce a leaf that is not in that position.",
  { ...bundle(4), pathElements: bundle(1).pathElements, pathIndices: bundle(1).pathIndices }
);

// 4 -----------------------------------------------------------------------
// Editing your own bundle can never reach the range check, because changing
// `age` changes the leaf and the Merkle check fires first. To actually test
// Num2Bits we need a leaf that genuinely CONTAINS p-1 -- so a rogue registrar
// writes it into the tree, making the path perfectly valid.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const wrapRegistry = JSON.parse(fs.readFileSync("registry/students.json", "utf8")).students.map(
  (s) => (s.roll === 9 ? { ...s, age: (P - 1n).toString() } : s)
);
const { bundles: wrapBundles } = await buildTree(wrapRegistry);
await mustFail(
  "4. age = p-1 baked into the leaf",
  "Merkle path is VALID here, so only Num2Bits(8) stops it. p-1 acts like -1; " +
    "without the range check it would sail through GreaterEqThan.",
  wrapBundles[9]
);

// 5 -----------------------------------------------------------------------
await mustFail(
  "5. claim a roll number you don't own",
  "rollNumber is inside the leaf hash, so swapping it breaks the Merkle path.",
  { ...bundle(1), rollNumber: "2" }
);

// 6 - these two SUCCEED off-chain, and must be caught by the verifier -----
console.log(`\n  VALID PROOFS OF THE WRONG STATEMENT — the circuit cannot stop these\n`);

await mustSucceed(
  "6. prove against threshold = 1",
  "circuit is satisfied. The VERIFIER must pin the threshold; see CourseGate.AGE_THRESHOLD.",
  { ...bundle(1), threshold: "1" }
);

const tampered = JSON.parse(fs.readFileSync("registry/students.json", "utf8")).students.map((s) =>
  s.roll === 9 ? { ...s, age: 18 } : s
);
const { bundles: rogue } = await buildTree(tampered);
await mustSucceed(
  "7. rogue registrar rewrites an age",
  "circuit is satisfied against the ROGUE root. The verifier must pin the root it trusts.",
  rogue[9]
);

console.log(`\n  ${pass} expected outcomes, ${fail} unexpected\n`);
console.log(`  Takeaway: the circuit enforces consistency with a commitment.`);
console.log(`  Choosing WHICH commitment and WHICH threshold to trust is the`);
console.log(`  verifier's job, and no amount of cryptography does it for you.\n`);

process.exit(fail === 0 ? 0 : 1);
