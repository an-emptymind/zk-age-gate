/**
 * THE COMPLETE ON-CHAIN FLOW, END TO END.
 *
 *   npm run onchain          # spins up its own anvil
 *   npm run onchain -- 5     # enrol a different student
 *
 * Starts a local chain, deploys both contracts, has a student generate a proof
 * on their own machine, submits it as a real transaction, then runs three
 * attacks against the deployed system. Everything printed is measured.
 */
import fs from "fs";
import { spawn } from "child_process";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

const ROLL = process.argv[2] ?? "1";
const RPC = "http://127.0.0.1:8545";
const B = "build";

// Anvil's first dev account. This key is published in Foundry's own docs and
// controls nothing but a throwaway local chain.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const h1 = (s) => console.log(`\n\x1b[1m${s}\x1b[0m\n${"─".repeat(64)}`);
const kv = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
const art = (p) => JSON.parse(fs.readFileSync(`contracts/out/${p}`, "utf8"));

// ------------------------------------------------------- call logging ----
const short = (v) => {
  const s = String(v);
  return s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
};
const fmtArg = (v) => (Array.isArray(v) ? `[ ${v.map(fmtArg).join(", ")} ]` : short(v));

/**
 * Print the exact function being called: canonical signature, 4-byte
 * selector, and every argument with its solidity type. Everything is read
 * from the contract's own ABI, so it cannot drift from the source.
 */
function logCall(iface, contractName, fnName, args) {
  const f = fnName === "constructor" ? iface.deploy : iface.getFunction(fnName);
  const sig = fnName === "constructor"
    ? `constructor(${f.inputs.map((i) => i.type).join(",")})`
    : f.format("sighash");
  console.log(`  \x1b[1m${contractName}.${sig}\x1b[0m`);
  if (fnName !== "constructor") console.log(`    ${"selector".padEnd(13)} ${"".padEnd(15)} ${f.selector}`);
  if (f.inputs.length === 0) console.log(`    ${"(no arguments)".padEnd(13)}`);
  f.inputs.forEach((inp, i) => {
    console.log(`    ${(inp.name || `arg${i}`).padEnd(13)} ${inp.type.padEnd(15)} ${fmtArg(args[i])}`);
  });
}

// ---------------------------------------------------------------- chain up
let anvil = null;

/** Plain fetch probe — ethers logs a retry warning if we let it do this. */
async function alive() {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(400),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function chain() {
  if (await alive()) {
    console.log("  using the anvil already running on :8545");
  } else {
    anvil = spawn("anvil", ["--silent"], { stdio: "ignore" });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await alive();
    }
    if (!up) throw new Error("anvil did not come up on :8545");
    console.log("  started a local anvil chain on :8545");
  }
  return new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
}

const main = async () => {
  h1("0 · local chain");
  const provider = await chain();
  const wallet = new ethers.Wallet(DEV_KEY, provider);
  kv("chain id", (await provider.getNetwork()).chainId);
  kv("deployer", wallet.address);
  kv("balance", ethers.formatEther(await provider.getBalance(wallet.address)) + " ETH");

  // ------------------------------------------------------------ deployment
  h1("1 · the provider deploys  (Verifier = maths, CourseGate = policy)");
  const root = JSON.parse(fs.readFileSync(`${B}/root.json`, "utf8")).root;
  kv("registry root", root.slice(0, 24) + "…");
  kv("", "(the ONE number the college published — nothing else left the registrar)");

  const vArt = art("Verifier.sol/Groth16Verifier.json");
  const vFactory = new ethers.ContractFactory(vArt.abi, vArt.bytecode.object, wallet);
  logCall(vFactory.interface, "Groth16Verifier", "constructor", []);
  const verifier = await vFactory.deploy();
  await verifier.waitForDeployment();
  const vRcpt = await provider.getTransactionReceipt(verifier.deploymentTransaction().hash);
  kv("  → deployed at", await verifier.getAddress());
  kv("  → deploy gas", vRcpt.gasUsed.toString());

  console.log();
  const gArt = art("CourseGate.sol/CourseGate.json");
  const gFactory = new ethers.ContractFactory(gArt.abi, gArt.bytecode.object, wallet);
  const gateArgs = [await verifier.getAddress(), root];
  logCall(gFactory.interface, "CourseGate", "constructor", gateArgs);
  const gate = await gFactory.deploy(...gateArgs);
  await gate.waitForDeployment();
  const gRcpt = await provider.getTransactionReceipt(gate.deploymentTransaction().hash);
  kv("  → deployed at", await gate.getAddress());
  kv("  → deploy gas", gRcpt.gasUsed.toString());

  console.log();
  logCall(gate.interface, "CourseGate", "AGE_THRESHOLD", []);
  kv("  → returns", (await gate.AGE_THRESHOLD()).toString() + "   (constant — no caller can change it)");

  // --------------------------------------------------------------- proving
  h1(`2 · student ${ROLL} proves, on their own machine`);
  const truth = JSON.parse(fs.readFileSync("registry/students.json", "utf8")).students.find(
    (s) => String(s.roll) === String(ROLL)
  );
  kv("registry says", `${truth.name}, class ${truth.class}, age ${truth.age}`);
  kv("", "(this line is the DEMO cheating — the chain never sees any of it)");

  const input = JSON.parse(fs.readFileSync(`${B}/bundles/${ROLL}.json`, "utf8"));
  const t0 = Date.now();
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      `${B}/agegate_js/agegate.wasm`,
      `${B}/agegate_final.zkey`
    ));
  } catch {
    console.log(`\n  PROOF REFUSED — age ${truth.age} < 18, the circuit has no witness.`);
    console.log(`  Nothing reaches the chain. There is no transaction to send.\n`);
    return;
  }
  kv("proving time", `${Date.now() - t0} ms`);
  kv("proof", "3 curve points = 256 bytes");
  kv("public signals", `[ root…, ${publicSignals[1]}, ${publicSignals[2]} ]`);
  kv("stays on the laptop", "name, class, age, salt, merkle path");

  // snarkjs's calldata order: G2 coordinate pairs are reversed for the EVM.
  const a = [proof.pi_a[0], proof.pi_a[1]];
  const b = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const c = [proof.pi_c[0], proof.pi_c[1]];

  // ------------------------------------------------------------ the tx
  h1("3 · the transaction");
  logCall(gate.interface, "CourseGate", "enroll", [a, b, c, ROLL]);

  // What CourseGate does internally with those arguments. This is the line
  // that matters most: the caller supplied only rollNumber; the contract
  // supplies root and threshold from its own storage.
  const vIface = new ethers.Interface(art("CourseGate.sol/IVerifier.json").abi);
  console.log(`\n  \x1b[2m…which makes this internal call:\x1b[0m`);
  logCall(vIface, "IVerifier", "verifyProof", [a, b, c, publicSignals]);
  console.log(`    ${"".padEnd(13)} ${"".padEnd(15)} ↑ [ registryRoot, rollNumber, AGE_THRESHOLD ]`);
  console.log(`    ${"".padEnd(13)} ${"".padEnd(15)}   only the middle one came from the caller\n`);

  const tx = await gate.enroll(a, b, c, ROLL);
  kv("tx hash", tx.hash);
  const rcpt = await tx.wait();
  kv("status", rcpt.status === 1 ? "success" : "reverted");
  kv("gas used", rcpt.gasUsed.toString());
  kv("calldata size", ethers.dataLength(tx.data) + " bytes");

  const ev = rcpt.logs
    .map((l) => { try { return gate.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean)[0];
  kv("event", `${ev.name}(rollNumber = ${ev.args[0]})`);

  h1("4 · chain state now");
  logCall(gate.interface, "CourseGate", "enrolled", [ROLL]);
  kv("  → returns", await gate.enrolled(ROLL));
  console.log();
  logCall(gate.interface, "CourseGate", "enrolledCount", []);
  kv("  → returns", (await gate.enrolledCount()).toString());
  console.log();
  kv("age stored anywhere?", "no — the chain only ever saw a roll number");

  // -------------------------------------------------------------- attacks
  h1("5 · attacks against the deployed contract");

  // ethers v6 decodes a custom error into e.revert when the ABI knows it;
  // otherwise fall back to decoding the raw revert data ourselves.
  const revertName = (e) => {
    if (e.revert?.name) return e.revert.name;
    const data = e.data ?? e.info?.error?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try {
        return gate.interface.parseError(data)?.name ?? "unknown error";
      } catch {}
    }
    if (/out of gas|OutOfGas|intrinsic/i.test(e.shortMessage ?? e.message ?? "")) return "out of gas";
    return "rejected";
  };

  const attack = async (label, args, why) => {
    console.log(`\n  \x1b[1m${label}\x1b[0m`);
    logCall(gate.interface, "CourseGate", "enroll", args);
    try {
      await gate.enroll.staticCall(...args);
      console.log(`    → SUCCEEDED  <-- BUG`);
    } catch (e) {
      console.log(`    → reverted: \x1b[1m${revertName(e)}\x1b[0m`);
      console.log(`      ${why}`);
    }
  };

  await attack(
    "replay the identical proof",
    [a, b, c, ROLL],
    "the enrolled mapping burns the claim — proofs are replayable bytes"
  );

  const other = ROLL === "2" ? "3" : "2";
  await attack(
    `same proof, rollNumber changed to ${other}`,
    [a, b, c, other],
    "rollNumber is a public input; changing it changes vk_x and the pairing fails"
  );

  await attack(
    "one bit flipped in a[1]",
    [[a[0], (BigInt(a[1]) ^ 1n).toString()], b, c, "3"],
    "not a curve point — and note this burns the whole gas budget before reverting"
  );

  h1("summary");
  console.log(`  The chain learned:     roll ${ROLL} is a registered student, 18 or over`);
  console.log(`  The chain never saw:   age, name, class, or the registry itself`);
  console.log(`  Cost:                  ${rcpt.gasUsed} gas, flat regardless of circuit size\n`);
};

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    // anvil is a child process and snarkjs leaves worker handles open, so the
    // event loop would otherwise never drain. Tear down and exit explicitly.
    if (anvil) anvil.kill();
    setTimeout(() => process.exit(process.exitCode ?? 0), 150);
  });
