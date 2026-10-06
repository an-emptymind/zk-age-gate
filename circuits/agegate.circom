pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "merkle.circom";

/**
 * "Roll number R belongs to a student in the college registry, and that
 *  student is at least `threshold` years old."
 *
 * PUBLIC  root, rollNumber, threshold
 * PRIVATE name, class, age, salt, and the Merkle path
 *
 * The course provider learns the roll number and nothing else. Not the age,
 * not the name, not the class — and crucially not even *how far over* 18 the
 * student is, which a plain "date of birth" disclosure would leak.
 */
template AgeGate(levels) {
    // ---- private: the witness. Never leaves the student's machine. --------
    signal input name;
    signal input class;
    signal input age;
    signal input salt;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // ---- public: what the verifier already knows and supplies -------------
    signal input root;
    signal input rollNumber;
    signal input threshold;

    // ---- 1. rebuild the registry leaf from the private fields -------------
    // If the student changes ANY field to cheat -- bumping age from 16 to 18 --
    // the leaf changes, the path no longer reaches the root, and step 2 fails.
    component leafHash = Poseidon(5);
    leafHash.inputs[0] <== name;
    leafHash.inputs[1] <== rollNumber;
    leafHash.inputs[2] <== class;
    leafHash.inputs[3] <== age;
    leafHash.inputs[4] <== salt;

    // ---- 2. that leaf really is in the college's published tree -----------
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== leafHash.out;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i]  <== pathIndices[i];
    }

    // ---- 3. range checks --------------------------------------------------
    // Field elements wrap mod p. Without these two lines, age = p - 1 is a
    // perfectly legal signal that behaves like -1 and sails through the
    // comparison below. Chapter 21's favourite bug. Num2Bits(8) forces
    // 0 <= age < 256, which is also what GreaterEqThan(8) needs to be sound.
    component ageBits = Num2Bits(8);
    ageBits.in <== age;

    component thresholdBits = Num2Bits(8);
    thresholdBits.in <== threshold;

    // ---- 4. the actual gate ----------------------------------------------
    component isOldEnough = GreaterEqThan(8);
    isOldEnough.in[0] <== age;
    isOldEnough.in[1] <== threshold;
    isOldEnough.out === 1;
}

component main {public [root, rollNumber, threshold]} = AgeGate(4);
