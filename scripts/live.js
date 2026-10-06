/**
 * THE FULL FLOW AGAINST A LIVE TESTNET.
 *
 *   npm run live -- 1        # enrol student 1 on Sepolia
 *   npm run live -- 9        # an underage student: never reaches the chain
 *   npm run live -- 1 --check   # read-only: show state, send nothing
 *
 * Requires: npm run deploy:sepolia (once), and .env with PRIVATE_KEY.
 * This spends real Sepolia gas, so it confirms before broadcasting.
 */
import fs from "fs";
import readline from "readline";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

const B = "build";
const args = process.argv.slice(2);
const ROLL = args.find((a) => /^\d+$/.test(a)) ?? "5";
const CHECK_ONLY = args.includes("--check");

const h1 = (s) => console.log(`\n\x1b[1m${s}\x1b[0m\n${"─".repeat(64)}`);
const kv = (k, v) => console.log(`  ${k.padEnd(24)} ${v}`);
const short = (v) => (String(v).length > 20 ? `${String(v).slice(0, 8)}…${String(v).slice(-6)}` : String(v));
const fmtArg = (v) => (Array.isArray(v) ? `[ ${v.map(fmtArg).join(", ")} ]` : short(v));
const scan = (p) => `https://sepolia.etherscan.io/${p}`;

function logCall(iface, name, fn, callArgs) {
  const f = iface.getFunction(fn);
  console.log(`  \x1b[1m${name}.${f.format("sighash")}\x1b[0m`);
  console.log(`    ${"selector".padEnd(13)} ${"".padEnd(15)} ${f.selector}`);
  f.inputs.forEach((inp, i) =>
    console.log(`    ${(inp.name || `arg${i}`).padEnd(13)} ${inp.type.padEnd(15)} ${fmtArg(callArgs[i])}`)
  );
}

const ask = (q) =>
  new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); });
  });

// ------------------------------------------------------------------ env
function env() {
  if (!fs.existsSync(".env")) throw new Error("no .env — run:  cp .env.example .env");
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!process.env.SEPOLIA_RPC_URL) throw new Error("SEPOLIA_RPC_URL missing in .env");
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing in .env");
}

const main = async () => {
  env();

  const depPath = `${B}/deployment-sepolia.json`;
  if (!fs.existsSync(depPath)) throw new Error("not deployed yet — run:  npm run deploy:sepolia");
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const gArt = JSON.parse(fs.readFileSync("contracts/out/CourseGate.sol/CourseGate.json", "utf8"));
  const gate = new ethers.Contract(dep.courseGate, gArt.abi, wallet);

  // ----------------------------------------------------------- 0 preflight
  h1("0 · connected to Sepolia");
  const net = await provider.getNetwork();
  if (net.chainId !== 11155111n) throw new Error(`RPC is chain ${net.chainId}, not Sepolia`);
  kv("chain id", net.chainId.toString());
  kv("block", await provider.getBlockNumber());
  kv("wallet", wallet.address);
  const bal = await provider.getBalance(wallet.address);
  kv("balance", ethers.formatEther(bal) + " ETH");
  kv("CourseGate", dep.courseGate);
  kv("  etherscan", scan(`address/${dep.courseGate}`));
  kv("Verifier", dep.verifier);

  // The deployed root must match the tree we are proving against. If someone
  // re-ran `npm run tree`, every local bundle is now for a different registry.
  const localRoot = JSON.parse(fs.readFileSync(`${B}/root.json`, "utf8")).root;
  const chainRoot = (await gate.registryRoot()).toString();
  kv("root on chain", short(chainRoot));
  kv("root locally", short(localRoot));
  if (chainRoot !== localRoot) {
    console.log(`\n  \x1b[1mSTOP — root mismatch.\x1b[0m The registry was rebuilt after deployment,`);
    console.log(`  so every local bundle proves membership of a tree this contract`);
    console.log(`  does not trust. Either redeploy, or restore the old tree.\n`);
    process.exitCode = 1;
    return;
  }
  kv("", "match — local bundles are valid for this deployment");

  // ------------------------------------------------------------ 1 state
  h1("1 · current chain state");
  kv("enrolledCount()", (await gate.enrolledCount()).toString());
  kv(`enrolled(${ROLL})`, await gate.enrolled(ROLL));
  kv("AGE_THRESHOLD()", (await gate.AGE_THRESHOLD()).toString());

  if (CHECK_ONLY) {
    console.log(`\n  --check: read-only, nothing sent.\n`);
    return;
  }
  if (await gate.enrolled(ROLL)) {
    console.log(`\n  roll ${ROLL} is already enrolled. The contract would revert with`);
    console.log(`  AlreadyEnrolled — try another roll number.\n`);
    return;
  }

  // ------------------------------------------------------------ 2 prove
  h1(`2 · student ${ROLL} proves, locally`);
  const truth = JSON.parse(fs.readFileSync("registry/students.json", "utf8")).students.find(
    (s) => String(s.roll) === String(ROLL)
  );
  if (!truth) throw new Error(`no student with roll ${ROLL}`);
  kv("registry says", `${truth.name}, class ${truth.class}, age ${truth.age}`);
  kv("", "(demo only — none of this reaches Sepolia)");

  const input = JSON.parse(fs.readFileSync(`${B}/bundles/${ROLL}.json`, "utf8"));
  const t0 = Date.now();
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, `${B}/agegate_js/agegate.wasm`, `${B}/agegate_final.zkey`
    ));
  } catch {
    console.log(`\n  PROOF REFUSED — age ${truth.age} < 18, the circuit has no witness.`);
    console.log(`  No transaction is sent. Nothing is spent. There is nothing to submit.\n`);
    return;
  }
  kv("proving time", `${Date.now() - t0} ms`);
  kv("public signals", `[ root…, ${publicSignals[1]}, ${publicSignals[2]} ]`);
  kv("never leaves here", "name, class, age, salt, merkle path");

  const a = [proof.pi_a[0], proof.pi_a[1]];
  const b = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const c = [proof.pi_c[0], proof.pi_c[1]];

  // ------------------------------------------------------- 3 dry run + cost
  h1("3 · what will be sent");
  logCall(gate.interface, "CourseGate", "enroll", [a, b, c, ROLL]);

  await gate.enroll.staticCall(a, b, c, ROLL); // reverts here if it would fail
  console.log(`    → \x1b[1mstatic call succeeds\x1b[0m — the proof is accepted by the live contract`);

  const gasEst = await gate.enroll.estimateGas(a, b, c, ROLL);
  const fee = await provider.getFeeData();
  const cost = gasEst * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  console.log();
  kv("estimated gas", gasEst.toString());
  kv("max fee/gas", ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice ?? 0n, "gwei") + " gwei");
  kv("worst-case cost", ethers.formatEther(cost) + " ETH");
  if (bal < cost) {
    console.log(`\n  insufficient balance — fund ${wallet.address} at https://sepoliafaucet.com\n`);
    process.exitCode = 1;
    return;
  }

  const answer = await ask(`\n  broadcast this transaction to Sepolia? [y/N] `);
  if (answer !== "y" && answer !== "yes") {
    console.log(`\n  cancelled — nothing sent.\n`);
    return;
  }

  // ------------------------------------------------------------ 4 broadcast
  h1("4 · broadcasting");
  const tx = await gate.enroll(a, b, c, ROLL);
  kv("tx hash", tx.hash);
  kv("etherscan", scan(`tx/${tx.hash}`));
  console.log(`  waiting for a block…`);
  const rcpt = await tx.wait();
  kv("status", rcpt.status === 1 ? "success" : "REVERTED");
  kv("block", rcpt.blockNumber);
  kv("gas used", rcpt.gasUsed.toString());
  kv("effective price", ethers.formatUnits(rcpt.gasPrice, "gwei") + " gwei");
  kv("paid", ethers.formatEther(rcpt.gasUsed * rcpt.gasPrice) + " ETH");

  const ev = rcpt.logs
    .map((l) => { try { return gate.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean)[0];
  if (ev) kv("event", `${ev.name}(rollNumber = ${ev.args[0]})`);

  // ------------------------------------------------------------ 5 verify
  h1("5 · state after, read back from Sepolia");
  kv(`enrolled(${ROLL})`, await gate.enrolled(ROLL));
  kv("enrolledCount()", (await gate.enrolledCount()).toString());

  h1("6 · replay, against the live contract");
  logCall(gate.interface, "CourseGate", "enroll", [a, b, c, ROLL]);
  try {
    await gate.enroll.staticCall(a, b, c, ROLL);
    console.log(`    → SUCCEEDED  <-- BUG`);
  } catch (e) {
    const name = e.revert?.name ?? "rejected";
    console.log(`    → reverted: \x1b[1m${name}\x1b[0m  (no gas spent — this was a static call)`);
  }

  h1("summary");
  console.log(`  Sepolia learned:    roll ${ROLL} is a registered student, 18 or over`);
  console.log(`  Sepolia never saw:  age, name, class, or the registry`);
  console.log(`  Public record:      ${scan(`tx/${tx.hash}`)}\n`);
};

main()
  .catch((e) => { console.error(`\n  ${e.shortMessage ?? e.message}\n`); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 150));
