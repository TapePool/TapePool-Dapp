// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {RigReport, IRigFeed} from "./RigReport.sol";

/// @notice SPIKE ONLY. Option B of the data-feed bake-off: an off-chain signer reads the rig on BSC
///         and signs an EIP-712 `RigReport`; the borrower submits it with the borrow.
///         Each signature is accepted once. Freshness is checked by `RigReportCheck`.
contract SignedRigFeed is IRigFeed, EIP712 {
    bytes32 public constant RIG_REPORT_TYPEHASH = keccak256(
        "RigReport(uint64 rigId,uint64 circuitId,uint64 since,uint64 stopBlock,address circuits,uint64 observedAt,"
        "uint8 status,bool custodied,uint128 verifWeight,uint128 bonus,uint128 pending,uint64 bscBlock,uint32 taskId)"
    );

    address public immutable signer;
    address public immutable deployer;
    address public consumer;
    mapping(bytes32 digest => bool) public used;

    error NotConsumer();
    error AlreadyBound();
    error BadSignature();
    error Replayed();
    error WrongRig();

    /// @param signer_ The only key whose reports are accepted.
    constructor(address signer_) EIP712("Tape Pool rig feed", "1") {
        signer = signer_;
        deployer = msg.sender;
    }

    /// @notice One-time binding of the contract allowed to consume reports (stops signature griefing).
    function bind(address consumer_) external {
        if (msg.sender != deployer) revert NotConsumer();
        if (consumer != address(0)) revert AlreadyBound();
        consumer = consumer_;
    }

    /// @notice EIP-712 digest of `r` for this feed.
    function digest(RigReport memory r) public view returns (bytes32) {
        return _hashTypedDataV4(_structHash(r));
    }

    /// @inheritdoc IRigFeed
    /// @dev `proof` = abi.encode(RigReport, bytes signature).
    function consume(uint256 rigId, bytes calldata proof) external returns (RigReport memory r) {
        if (msg.sender != consumer) revert NotConsumer();
        bytes memory sig;
        (r, sig) = abi.decode(proof, (RigReport, bytes));
        if (r.rigId != rigId) revert WrongRig();
        bytes32 d = digest(r);
        if (used[d]) revert Replayed();
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(d, sig);
        if (err != ECDSA.RecoverError.NoError || got != signer) revert BadSignature();
        used[d] = true;
    }

    function _structHash(RigReport memory r) private pure returns (bytes32) {
        // two halves to stay inside the stack limit
        bytes memory a = abi.encode(
            RIG_REPORT_TYPEHASH, r.rigId, r.circuitId, r.since, r.stopBlock, r.circuits, r.observedAt, r.status
        );
        bytes memory b = abi.encode(r.custodied, r.verifWeight, r.bonus, r.pending, r.bscBlock, r.taskId);
        return keccak256(bytes.concat(a, b));
    }
}
