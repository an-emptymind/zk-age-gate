// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {CourseGate, IVerifier} from "../src/CourseGate.sol";
import {Groth16Verifier} from "../src/Verifier.sol";
import {Fixtures} from "./Fixtures.sol";

/// Minimal cheatcode surface, so the project needs no forge-std submodule.
interface Vm {
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertData) external;
}

contract CourseGateTest is Fixtures {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    CourseGate gate;
    Groth16Verifier verifier;

    function setUp() public {
        verifier = new Groth16Verifier();
        gate = new CourseGate(IVerifier(address(verifier)), REAL_ROOT);
    }

    function _enroll(Proof memory p) internal {
        gate.enroll(p.a, p.b, p.c, p.rollNumber);
    }

    // ------------------------------------------------------ fixture freshness

    /// GUARD. `Fixtures.sol` goes stale whenever `npm run tree` or
    /// `npm run setup` re-runs, because both change the root / proving key.
    ///
    /// That is dangerous in a specific way: every attack test below only
    /// asserts "reverts with InvalidProof", and a GARBAGE proof satisfies that
    /// just as well as a real one. Stale fixtures would make them pass
    /// vacuously while testing nothing at all.
    ///
    /// So assert here that each fixture is a genuine proof of its OWN
    /// statement. The attack fixtures must verify against the root and
    /// threshold they claim — they are rejected by CourseGate's policy, not by
    /// the maths. If this test fails, run: node scripts/gen-fixtures.js
    function test_fixturesAreGenuineProofs() public view {
        Proof memory h = honest1();
        require(
            verifier.verifyProof(h.a, h.b, h.c, [h.root, h.rollNumber, h.threshold]),
            "honest1 fixture stale - run node scripts/gen-fixtures.js"
        );
        Proof memory r = rogue9();
        require(
            verifier.verifyProof(r.a, r.b, r.c, [r.root, r.rollNumber, r.threshold]),
            "rogue9 fixture stale - it must be a REAL proof of a rogue root"
        );
        Proof memory l = lowBar1();
        require(
            verifier.verifyProof(l.a, l.b, l.c, [l.root, l.rollNumber, l.threshold]),
            "lowBar1 fixture stale - it must be a REAL proof at threshold 1"
        );
    }

    /// The honest fixtures must be for the root the gate was deployed with.
    function test_fixtureRootMatchesDeployment() public view {
        require(honest1().root == REAL_ROOT, "honest1 built against a different tree");
        require(gate.registryRoot() == REAL_ROOT, "gate deployed with a different root");
    }

    // ---------------------------------------------------------------- happy

    /// A registered 19-year-old enrolls. The contract never sees the age.
    function test_honestStudentEnrolls() public {
        Proof memory p = honest1();
        _enroll(p);
        require(gate.enrolled(1), "roll 1 should be enrolled");
        require(gate.enrolledCount() == 1, "count");
    }

    function test_twoDifferentStudentsEnroll() public {
        _enroll(honest1());
        _enroll(honest5());
        require(gate.enrolledCount() == 2, "both should enroll");
    }

    // -------------------------------------------------------------- attacks

    /// 1. Replay. Proofs are just bytes; nothing stops resubmitting them.
    ///    The enrolled[] mapping is what burns the claim.
    function test_attack_replaySameProof() public {
        Proof memory p = honest1();
        _enroll(p);
        vm.expectRevert(abi.encodeWithSelector(CourseGate.AlreadyEnrolled.selector, uint256(1)));
        _enroll(p);
    }

    /// 2. Steal someone else's proof and claim it for a different roll number.
    ///    rollNumber is a PUBLIC INPUT baked into the proof, so changing it in
    ///    the calldata changes vk_x and the pairing equation fails.
    function test_attack_replayUnderDifferentRoll() public {
        Proof memory p = honest1();
        vm.expectRevert(CourseGate.InvalidProof.selector);
        gate.enroll(p.a, p.b, p.c, 2); // proof says roll 1, caller claims roll 2
    }

    /// 3. A rogue registrar rewrites Arjun (15) as 18 and builds its own tree.
    ///    The proof is CRYPTOGRAPHICALLY VALID — it verifies against the rogue
    ///    root. It fails only because the gate hardcodes the root it trusts.
    ///    ZK proves consistency with a commitment, never truthfulness.
    function test_attack_rogueRegistry() public {
        Proof memory p = rogue9();
        require(p.root != REAL_ROOT, "fixture should use a different root");
        vm.expectRevert(CourseGate.InvalidProof.selector);
        gate.enroll(p.a, p.b, p.c, p.rollNumber);
    }

    /// 4. Prove against threshold = 1 instead of 18. Again a valid proof of a
    ///    useless statement. The gate supplies AGE_THRESHOLD itself, so the
    ///    caller's choice never reaches the verifier.
    function test_attack_lowerTheBar() public {
        Proof memory p = lowBar1();
        require(p.threshold == 1, "fixture should claim threshold 1");
        vm.expectRevert(CourseGate.InvalidProof.selector);
        gate.enroll(p.a, p.b, p.c, p.rollNumber);
    }

    /// 5. Garbage proof — a point that is not on the curve.
    ///
    /// FINDING: this reverts, but it first burns the ENTIRE gas budget.
    /// The snarkjs verifier runs checkField() on the three public signals
    /// only; the proof points go straight to the ecPairing precompile (0x08),
    /// which on invalid input fails *and consumes all gas forwarded to it*.
    ///
    /// Not a vulnerability — the attacker pays. But a user with a buggy proving
    /// client loses a full transaction's worth of gas instead of a cheap
    /// revert, so validate proofs off-chain before submitting.
    function test_attack_garbageProof() public {
        Proof memory p = honest1();
        p.a[0] = p.a[0] ^ 1;

        uint256 before = gasleft();
        vm.expectRevert(CourseGate.InvalidProof.selector);
        gate.enroll{gas: 500_000}(p.a, p.b, p.c, p.rollNumber);
        uint256 used = before - gasleft();

        // it consumed the whole 500k stipend rather than reverting cheaply
        require(used > 450_000, "expected the precompile to burn the gas budget");
    }

    // ------------------------------------------------------------------ gas

    function test_gas_enroll() public {
        Proof memory p = honest1();
        uint256 before = gasleft();
        _enroll(p);
        uint256 used = before - gasleft();
        require(used < 400_000, "enrollment should cost well under 400k");
    }
}
