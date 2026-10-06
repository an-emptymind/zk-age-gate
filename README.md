# zk-age-gate

Prove a student is **18 or over** without revealing their age, name or class.

A working Groth16 system: private registry → Merkle commitment → circom circuit
→ Solidity gate, with an attack suite showing exactly what it does and does not
protect.

```
COLLEGE   issuer     publishes ONE number (a Merkle root); registry stays private
STUDENT   prover     holds their row + path, generates the proof locally
PROVIDER  verifier   checks the proof against the published root
```

The provider learns **"roll 7 is a registered student, 18+"** and nothing else —
not the age, not the name, not the class, not even how far over 18 they are.

## The handbook

This project is the capstone of an interactive course on zero-knowledge proofs:
[`docs/zk-handbook.html`](docs/zk-handbook.html) — 22 chapters, 16 hands-on labs, three
worked examples. Open it in a browser, or serve it with GitHub Pages.

## Run it

```bash
npm install              # also fetches the pinned circom binary
npm run tree      # college: build the Merkle tree, issue student bundles
npm run setup     # one-time: compile, ceremony, proving key, Verifier.sol
npm run prove 1   # student 1 (age 19) generates a proof
npm run verify 1  # provider verifies it
npm run attack    # 7 attack scenarios
forge test -vv    # on-chain: 10 tests incl. 5 attacks
```

`npm install` fetches a pinned circom 2.2.3 binary into `bin/` via
`scripts/get-circom.sh` (macOS and Linux). Nothing is installed globally.

## Run it on Sepolia

```bash
cp .env.example .env      # add PRIVATE_KEY (+ ETHERSCAN_API_KEY to verify source)
npm run deploy:sepolia    # deploys both contracts, verifies on Etherscan
npm run live -- 1         # enrol student 1 on the live testnet
npm run live -- 1 --check # read-only: show chain state, send nothing
npm run live -- 9         # underage: refused locally, no transaction sent
```

Use a **throwaway key** holding only Sepolia test ETH. `.env` is gitignored.

`deploy-sepolia.sh` refuses to run if the RPC isn't Sepolia, if the deployer has
no balance, or if the tree and proving key haven't been built. It writes
`build/deployment-sepolia.json` and prints both Etherscan links.

`live.js` is deliberately cautious: it checks that the **root on chain matches
your local tree** (rebuilding the registry after deployment invalidates every
bundle), runs a `staticCall` and a gas estimate, prints the cost in ETH, and
**asks before broadcasting**. Then it reads the state back from Sepolia and
replays the proof to show `AlreadyEnrolled`.

## The circuit

`circuits/agegate.circom` — 1333 non-linear constraints, 3 public / 12 private inputs.

```
private:  name, class, age, salt, pathElements[4], pathIndices[4]
public:   root, rollNumber, threshold

leaf = Poseidon(name, rollNumber, class, age, salt)
MerkleTreeChecker(leaf, path) === root        // I'm really in the registry
Num2Bits(8)(age)                              // range check
GreaterEqThan(8)([age, threshold]) === 1      // the gate
```

Three lines are load-bearing and easy to get wrong:

| Line | Without it |
|---|---|
| `salt` in the leaf | 10 rolls × ~100 ages is a trivial search space — the provider brute-forces the leaf and recovers the exact age |
| `Num2Bits(8)(age)` | `age = p−1` behaves like `−1` and passes the comparison (verified in attack 4) |
| `s * (1 - s) === 0` in `DualMux` | a non-boolean path index blends the hash inputs into a value belonging to neither branch |

## What the attack suite shows

**Blocked at witness generation** — no proof artefact even exists:

| Attack | Caught by |
|---|---|
| underage student proves 18+ | `AgeGate` line 67 |
| student edits their own age 16 → 19 | `MerkleTreeChecker` line 58 |
| student borrows an eligible student's path | `MerkleTreeChecker` line 58 |
| `age = p−1` baked into the leaf | `Num2Bits` line 38 |
| student claims a roll number they don't own | `MerkleTreeChecker` line 58 |

**Valid proofs of the wrong statement** — the circuit *cannot* stop these; the
verifier must:

| Attack | Defence |
|---|---|
| prove against `threshold = 1` | `CourseGate.AGE_THRESHOLD` is a constant the caller never supplies |
| rogue registrar rewrites an age into its own tree | `registryRoot` is `immutable`, set at deployment |

That split is the point of the project. **The circuit enforces consistency with
a commitment. Choosing which commitment and which threshold to trust is the
verifier's job, and no amount of cryptography does it for you.**

## Gas

Measured with `forge test --gas-report`:

| | gas |
|---|---|
| `Groth16Verifier.verifyProof` | 202,220 |
| `CourseGate.enroll` (incl. SSTORE) | 268,854 |
| Verifier deployment | 385,517 |

Flat with respect to circuit size — a 20-level Merkle tree would cost the same
on chain and only slow the prover down.

**Finding:** a malformed proof point (not on the curve) reverts but first burns
the *entire* gas budget. The snarkjs verifier `checkField`s the three public
signals, but the proof points go straight to the `ecPairing` precompile, which
on invalid input fails *and consumes all gas forwarded to it*. Not exploitable —
the attacker pays — but validate proofs off-chain before submitting so a buggy
client doesn't cost a user a full transaction.

## A trap worth knowing about

`contracts/test/Fixtures.sol` holds real proofs baked into Solidity. It goes
**stale** whenever `npm run tree` or `npm run setup` re-runs, because both change
the root / proving key. Regenerate with `node scripts/gen-fixtures.js`.

The subtle danger: every attack test only asserts *"reverts with `InvalidProof`"*,
and a **garbage** proof satisfies that just as well as a real one. Stale fixtures
therefore make the attack suite pass *vacuously* — green, while testing nothing.
That happened during development and was caught only by accident.

`test_fixturesAreGenuineProofs` now closes the hole: it asserts each fixture is a
genuine proof of **its own** statement, so the attack proofs are rejected by
policy rather than by the maths. Corrupting one limb of the `rogue9` fixture makes
`test_attack_rogueRegistry` still pass — and that guard fail.

**General lesson:** a test that asserts *"this fails"* proves nothing unless you
separately prove the input was otherwise valid.

## Limitations — read before reusing this

1. **ZK does not make the college honest.** It proves a claim is consistent with
   what the college committed to, never that the commitment is true. A corrupt
   registrar can write age 99 for a 15-year-old, and attack 7 demonstrates
   exactly this. Cryptography secures the channel, not the source. Real systems
   anchor to a government credential, not a college one.

2. **Ages go stale.** `age: 17` is wrong on the student's next birthday and the
   whole tree must be rebuilt. Storing a date of birth and proving
   `dob <= cutoff`, with the contract deriving `cutoff` from `block.timestamp`,
   fixes this permanently. Left out here to keep the circuit readable.

3. **Roll numbers are public by design.** This matches the requirement that the
   provider verifies "a particular student". If you want anonymity, drop
   `rollNumber` from the public list and add a nullifier — but note that with
   10 students the anonymity set is nearly useless.

4. **The ceremony is a demo.** `scripts/setup.sh` generates its own powers of
   tau, which means *we know the toxic waste*. Anything real must reuse the
   Perpetual Powers of Tau transcript and run a multi-party phase 2.

5. **Bundles are as sensitive as private keys.** Anyone holding
   `build/bundles/N.json` can prove that student is 18+. The college should
   delete its copies after issuing.

6. **Not audited.** Teaching code.

## Layout

```
bin/circom                  pinned compiler (2.2.3)
registry/students.json      the private registry — gitignored in a real repo
registry/tree-lib.js        Poseidon Merkle tree, shared with the attack fixtures
registry/build-tree.js      college side: root + per-student bundles
circuits/merkle.circom      DualMux + MerkleTreeChecker
circuits/agegate.circom     the statement
scripts/setup.sh            compile → ceremony → zkey → Verifier.sol
scripts/prove.js            student side
scripts/verify.js           provider side, off-chain
scripts/attack.js           7 attack scenarios
scripts/gen-fixtures.js     bakes real proofs into Solidity for forge
contracts/src/CourseGate.sol   the gate
contracts/src/Verifier.sol     generated by snarkjs
contracts/test/CourseGate.t.sol 8 tests, no forge-std dependency
```
