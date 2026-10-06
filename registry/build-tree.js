/**
 * COLLEGE SIDE — run once, by the registrar.
 *
 * Commits to the private registry as a Poseidon Merkle tree and emits:
 *   build/root.json        the ONE number the college publishes on chain
 *   build/bundles/N.json   a private packet handed to student N (row + path)
 *
 * The registry itself never leaves this machine.
 */
import fs from "fs";
import path from "path";
import { buildTree, DEPTH } from "./tree-lib.js";

const OUT = "build";

const { students } = JSON.parse(fs.readFileSync("registry/students.json", "utf8"));
const { root, bundles, rows, verified, size } = await buildTree(students);

fs.mkdirSync(path.join(OUT, "bundles"), { recursive: true });
fs.writeFileSync(
  path.join(OUT, "root.json"),
  JSON.stringify({ root: root.toString(), depth: DEPTH, leafCount: size }, null, 2)
);
fs.writeFileSync(
  path.join(OUT, "bundles", "README.txt"),
  [
    "PRIVATE — one file per student, handed only to that student.",
    "",
    "Each bundle contains the student's real age and their Merkle path.",
    "Anyone holding a bundle can prove that student is 18+, so treat it",
    "like a private key. The college should delete its copies after issuing.",
    "",
    "Every key in a bundle is fed to the circuit as an input signal, so the",
    "files carry circuit inputs and nothing else — not even a comment field.",
  ].join("\n")
);

// A salt is what stops the verifier brute-forcing the leaf. Without it,
// 10 roll numbers x ~100 ages x a few classes is a search space you could
// exhaust in milliseconds, recovering the exact age from the leaf hash.
for (const [roll, bundle] of Object.entries(bundles)) {
  fs.writeFileSync(path.join(OUT, "bundles", `${roll}.json`), JSON.stringify(bundle, null, 2));
}

console.log(`\n  students        ${rows.length} (${rows.filter((r) => r.age >= 18).length} are 18+)`);
console.log(`  tree depth      ${DEPTH}  (${size} slots)`);
console.log(`  merkle root     ${root}`);
console.log(`  paths verified  ${verified}/${rows.length}${verified === rows.length ? "  OK" : "  FAILED"}`);
console.log(`\n  published  -> ${OUT}/root.json        (public, goes on chain)`);
console.log(`  private    -> ${OUT}/bundles/*.json    (one per student)\n`);

if (verified !== rows.length) process.exit(1);
