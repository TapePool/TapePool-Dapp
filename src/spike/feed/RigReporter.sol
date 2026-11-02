// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RigReport} from "./RigReport.sol";
import {BscRigReader} from "./BscRigReader.sol";
import {IRigVaultBsc, IPodMining} from "../../interfaces/IBsc.sol";
import {ILzEndpointSend, MessagingParams, MessagingFee, MessagingReceipt} from "../../interfaces/ILayerZero.sol";

/// @notice SPIKE ONLY. Option A of the data-feed bake-off, BSC side: anyone pays the LayerZero fee
///         to read up to 16 rigs on BSC and push their reports to the X Layer receiver.
///         The data is read on-chain, so no key of ours vouches for it.
/// @dev A production version should use LayerZero's audited OApp base contracts instead of this
///      hand-rolled sender. The DVN set must be configured explicitly: the default for a new OApp
///      on BSC -> X Layer is the dead DVN.
contract RigReporter {
    uint256 public constant MAX_RIGS = 16;
    uint128 public constant BASE_GAS = 60_000;
    uint128 public constant GAS_PER_RIG = 120_000; // 16 cold rigs measured at 1.54M total

    ILzEndpointSend public immutable endpoint;
    IRigVaultBsc public immutable vault;
    IPodMining public immutable pod;
    uint32 public immutable dstEid;
    address public immutable owner;
    bytes32 public peer; // receiver on X Layer
    bool public locked;

    event Pushed(bytes32 indexed guid, uint256 rigs, uint256 fee);
    event Locked(address sendLibrary);

    error NotOwner();
    error NoPeer();
    error BadBatch();
    error IsLocked();

    constructor(ILzEndpointSend endpoint_, IRigVaultBsc vault_, IPodMining pod_, uint32 dstEid_, address owner_) {
        endpoint = endpoint_;
        vault = vault_;
        pod = pod_;
        dstEid = dstEid_;
        owner = owner_;
        endpoint_.setDelegate(owner_); // lets the owner set DVN / executor config on the endpoint
    }

    /// @notice Set the X Layer receiver. Owner only.
    function setPeer(bytes32 peer_) external {
        if (msg.sender != owner) revert NotOwner();
        if (locked) revert IsLocked();
        peer = peer_;
    }

    /// @notice Freeze the trust setup for good: pin `sendLibrary` (so a change of LayerZero's
    ///         default cannot drop our DVN config), remove the delegate and freeze the peer.
    ///         After this, nobody of ours can change who vouches for the data. Owner only.
    function lock(address sendLibrary) external {
        if (msg.sender != owner) revert NotOwner();
        if (locked) revert IsLocked();
        if (peer == bytes32(0)) revert NoPeer();
        endpoint.setSendLibrary(address(this), dstEid, sendLibrary);
        endpoint.setDelegate(address(0));
        locked = true;
        emit Locked(sendLibrary);
    }

    /// @notice Native fee to push reports for `rigIds`.
    function quote(uint256[] calldata rigIds) external view returns (uint256) {
        MessagingFee memory f = endpoint.quote(_params(rigIds), address(this));
        return f.nativeFee;
    }

    /// @notice Read `rigIds` on BSC now and send their reports to X Layer. Excess fee is refunded.
    function push(uint256[] calldata rigIds) external payable returns (bytes32 guid) {
        MessagingReceipt memory rc = endpoint.send{value: msg.value}(_params(rigIds), msg.sender);
        emit Pushed(rc.guid, rigIds.length, rc.fee.nativeFee);
        return rc.guid;
    }

    /// @notice Executor options: lzReceive gas only (type 3 options).
    function options(uint256 n) public pure returns (bytes memory) {
        uint128 gas = BASE_GAS + GAS_PER_RIG * uint128(n);
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas);
    }

    function _params(uint256[] calldata rigIds) private view returns (MessagingParams memory) {
        if (peer == bytes32(0)) revert NoPeer();
        uint256 n = rigIds.length;
        if (n == 0 || n > MAX_RIGS) revert BadBatch();
        RigReport[] memory rs = new RigReport[](n);
        for (uint256 i; i < n; i++) {
            rs[i] = BscRigReader.read(vault, pod, rigIds[i]);
        }
        return MessagingParams(dstEid, peer, abi.encode(rs), options(n), false);
    }
}
