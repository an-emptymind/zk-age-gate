// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata input
    ) external view returns (bool);
}

/**
 * Gates enrollment on "you are a registered student aged 18 or over",
 * without ever learning anyone's age.
 *
 * The college publishes one number here — the Merkle root of its registry —
 * and then goes offline. Students prove membership against it directly.
 */
contract CourseGate {
    IVerifier public immutable verifier;

    /// The college's commitment to its registry. Immutable: a mutable root
    /// would let whoever can set it mint eligibility for anyone.
    uint256 public immutable registryRoot;

    /// Fixed by the course, never by the caller. See enroll() for why.
    uint256 public constant AGE_THRESHOLD = 18;

    mapping(uint256 => bool) public enrolled;
    uint256 public enrolledCount;

    event Enrolled(uint256 indexed rollNumber);

    error AlreadyEnrolled(uint256 rollNumber);
    error InvalidProof();

    constructor(IVerifier _verifier, uint256 _registryRoot) {
        verifier = _verifier;
        registryRoot = _registryRoot;
    }

    /**
     * The proof asserts: "rollNumber is a leaf in `registryRoot`, and that
     * leaf's age is >= AGE_THRESHOLD."
     *
     * Note what the caller does NOT get to supply: the root, or the threshold.
     * Both are read from storage and passed into verification by the contract
     * itself. If the caller could pass them, they would simply submit a proof
     * against their own registry, or against a threshold of 1 — the proof
     * would verify perfectly and mean nothing. Binding every public input to
     * a value the verifier controls is the whole game.
     */
    function enroll(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 rollNumber
    ) external {
        if (enrolled[rollNumber]) revert AlreadyEnrolled(rollNumber);

        bool ok = verifier.verifyProof(a, b, c, [registryRoot, rollNumber, AGE_THRESHOLD]);
        if (!ok) revert InvalidProof();

        enrolled[rollNumber] = true; // effects...
        enrolledCount++;
        emit Enrolled(rollNumber); // ...then interaction (none here)
    }
}
