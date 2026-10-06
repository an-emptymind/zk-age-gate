/**
 * COURSE PROVIDER SIDE. Runs on the provider's machine (or in a contract).
 *
 *   node scripts/verify.js 1
 *
 * The provider holds only: the verification key, and the Merkle root the
 * college published. It never sees the registry.
 */
import fs from "fs";
import * as snarkjs from "snarkjs";

const roll = process.argv[2] ?? "1";
const B = "build";

const vkey = JSON.parse(fs.readFileSync(`${B}/vkey.json`, "utf8"));
const proof = JSON.parse(fs.readFileSync(`${B}/proof-${roll}.json`, "utf8"));
const publicSignals = JSON.parse(fs.readFileSync(`${B}/public-${roll}.json`, "utf8"));

// The root the provider trusts, fetched from chain in a real deployment.
const trustedRoot = JSON.parse(fs.readFileSync(`${B}/root.json`, "utf8")).root;

const [root, rollNumber, threshold] = publicSignals;

console.log(`\n  verifying a claim for roll ${rollNumber}`);

// 1 - is the proof internally valid?
const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);

// 2 - does it speak about the registry we trust, and the threshold we require?
//     A proof can be perfectly valid and still be about the wrong statement.
const rootOk = root === trustedRoot;
const thresholdOk = threshold === "18";

console.log(`    proof valid            ${ok ? "yes" : "NO"}`);
console.log(`    root matches ours      ${rootOk ? "yes" : "NO"}`);
console.log(`    threshold is 18        ${thresholdOk ? "yes" : "NO — claimed " + threshold}`);

const accepted = ok && rootOk && thresholdOk;
console.log(`\n  ${accepted ? "ACCEPTED" : "REJECTED"} — roll ${rollNumber}${accepted ? " is a registered student aged 18 or over" : ""}`);

if (accepted) {
  console.log(`\n  the provider now knows:      roll ${rollNumber} is registered, and 18+`);
  console.log(`  the provider does not know:  the age, the name, the class,`);
  console.log(`                               or how far over 18 the student is\n`);
}

process.exit(accepted ? 0 : 1);
