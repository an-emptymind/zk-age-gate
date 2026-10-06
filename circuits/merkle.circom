pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

/**
 * Picks which of two values goes left and which goes right, based on one bit.
 *
 * A circuit has no `if`. So instead of branching we compute a blend:
 *     out = in[0] + s*(in[1] - in[0])
 * which is in[0] when s = 0 and in[1] when s = 1. This is the
 * "compute both branches and select" pattern from Chapter 12.
 *
 * The `s * (1 - s) === 0` line is NOT optional. Without it an attacker can
 * set s = 7 and the blend produces a value that belongs to no branch at all,
 * letting them steer the hash. That is the under-constrained bug from
 * Chapter 21, in one line.
 */
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;

    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

/**
 * Walks a leaf up to the root, hashing with its sibling at each level.
 *
 * pathElements[i] is the sibling at level i.
 * pathIndices[i]  is 0 if we are the LEFT child, 1 if we are the RIGHT child.
 *
 * Proving you know a valid path is proving membership — without revealing
 * WHICH leaf you are, because the path is private.
 */
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component selectors[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i - 1].out;
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
    }

    root === hashers[levels - 1].out;
}
