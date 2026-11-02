// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The two pool roles `RigScreen` reads. `TapePool` already provides both.
interface IPoolAuthority {
    function owner() external view returns (address);
    function guardian() external view returns (address);
}

/// @notice Registry of revocation-screen passes (SPEC §7.3, SPEC-PHASE3 §3).
///         The owner records a pass for a rig after an off-chain equivalence proof; it becomes
///         effective 48 h later, so anyone can check the published proof first. The guardian or the
///         owner suspends a pass at once; only the owner lifts a suspension or revokes a pass.
///         Owner and guardian are read from the pool on every state-changing call, so one
///         `setGuardian` or ownership transfer there rotates them here too.
contract RigScreen {
    struct Pass {
        address circuits; // BSC processor (Circuits contract)
        uint64 circuitId;
        uint32 taskId;
        uint64 effectiveAt; // 0 = no pass
        bytes32 artifactHash; // keccak256 of the published proof bundle
    }

    /// @notice Delay before a new or re-recorded pass counts (SPEC §2 `TIMELOCK`).
    uint256 public constant DELAY = 48 hours;

    /// @notice The pool whose owner and guardian govern this registry.
    IPoolAuthority public immutable pool;

    mapping(uint256 rigId => Pass) internal _passes;

    /// @notice True while a rig's pass is suspended. Set even when no pass exists yet.
    mapping(uint256 rigId => bool) public suspended;

    event ScreenPassAdded(
        uint256 indexed rigId,
        address circuits,
        uint64 circuitId,
        uint32 taskId,
        bytes32 artifactHash,
        uint64 effectiveAt
    );
    event PassSuspended(uint256 indexed rigId, address indexed by);
    event PassSuspensionLifted(uint256 indexed rigId);
    event ScreenPassRevoked(uint256 indexed rigId);

    error ZeroAddress();
    error NotOwner();
    error NotGuardianOrOwner();
    error BadPass();

    constructor(IPoolAuthority pool_) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        pool = pool_;
    }

    modifier onlyOwner() {
        if (msg.sender != pool.owner()) revert NotOwner();
        _;
    }

    // ───────────────────────── owner and guardian levers (SPEC §12)

    /// @notice Record or replace the pass for `rigId`. It becomes effective after `DELAY`; recording
    ///         again resets the delay. A suspension is left as it is. Owner only.
    /// @param rigId Voucher id (same as the BSC vault rig id).
    /// @param circuits BSC processor the proof covers.
    /// @param circuitId Circuit id on that processor.
    /// @param taskId PodMining task the proof is against.
    /// @param artifactHash keccak256 of the published proof bundle.
    function recordPass(uint256 rigId, address circuits, uint64 circuitId, uint32 taskId, bytes32 artifactHash)
        external
        onlyOwner
    {
        if (circuits == address(0) || artifactHash == bytes32(0)) revert BadPass();
        // forge-lint: disable-next-line(unsafe-typecast) a timestamp plus 48 h fits uint64
        uint64 effectiveAt = uint64(block.timestamp + DELAY);
        _passes[rigId] = Pass({
            circuits: circuits,
            circuitId: circuitId,
            taskId: taskId,
            effectiveAt: effectiveAt,
            artifactHash: artifactHash
        });
        emit ScreenPassAdded(rigId, circuits, circuitId, taskId, artifactHash, effectiveAt);
    }

    /// @notice Suspend `rigId`'s pass at once, even before one is recorded. Guardian or owner.
    /// @param rigId Voucher id.
    function suspendPass(uint256 rigId) external {
        if (msg.sender != pool.guardian() && msg.sender != pool.owner()) revert NotGuardianOrOwner();
        suspended[rigId] = true;
        emit PassSuspended(rigId, msg.sender);
    }

    /// @notice Lift a suspension at once. Owner only.
    /// @param rigId Voucher id.
    function liftSuspension(uint256 rigId) external onlyOwner {
        suspended[rigId] = false;
        emit PassSuspensionLifted(rigId);
    }

    /// @notice Delete `rigId`'s pass and clear its suspension. A later pass is a new record with the
    ///         full delay. Owner only.
    /// @param rigId Voucher id.
    function revokePass(uint256 rigId) external onlyOwner {
        delete _passes[rigId];
        suspended[rigId] = false;
        emit ScreenPassRevoked(rigId);
    }

    // ───────────────────────── views (never read the pool)

    /// @notice True only if `rigId` has a pass for exactly this circuit and task, its delay has passed
    ///         and it is not suspended.
    /// @param rigId Voucher id.
    /// @param circuits BSC processor from the rig report.
    /// @param circuitId Circuit id from the rig report.
    /// @param taskId Task id from the rig report.
    function isEffective(uint256 rigId, address circuits, uint64 circuitId, uint32 taskId)
        external
        view
        returns (bool)
    {
        Pass storage p = _passes[rigId];
        return p.effectiveAt != 0 && block.timestamp >= p.effectiveAt && !suspended[rigId] && p.circuits == circuits
            && p.circuitId == circuitId && p.taskId == taskId;
    }

    /// @notice The stored pass for `rigId` (all zero if none) and whether it is suspended.
    /// @param rigId Voucher id.
    function passOf(uint256 rigId) external view returns (Pass memory pass, bool isSuspended) {
        return (_passes[rigId], suspended[rigId]);
    }
}
