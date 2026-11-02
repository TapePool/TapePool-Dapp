// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RigReport, IRigFeed} from "./RigReport.sol";
import {Origin} from "../../interfaces/IXLayer.sol";
import {ILzEndpointSend, ILzReceiver} from "../../interfaces/ILayerZero.sol";

/// @notice SPIKE ONLY. Option A of the data-feed bake-off, X Layer side: accepts report batches
///         from the BSC reporter through the LayerZero endpoint and keeps the newest report per rig.
/// @dev Messages are unordered; an older report never replaces a newer one.
contract RigReportReceiver is IRigFeed, ILzReceiver {
    ILzEndpointSend public immutable endpoint;
    uint32 public immutable srcEid;
    address public immutable owner;
    bytes32 public peer; // reporter on BSC
    bool public locked;
    mapping(uint256 rigId => RigReport) internal _latest;

    event Reported(uint256 indexed rigId, uint64 observedAt, bool stored);
    event Locked(address receiveLibrary);

    error NotOwner();
    error NotEndpoint();
    error BadOrigin();
    error NoReport();
    error IsLocked();

    constructor(ILzEndpointSend endpoint_, uint32 srcEid_, address owner_) {
        endpoint = endpoint_;
        srcEid = srcEid_;
        owner = owner_;
        endpoint_.setDelegate(owner_);
    }

    /// @notice Set the BSC reporter. Owner only.
    function setPeer(bytes32 peer_) external {
        if (msg.sender != owner) revert NotOwner();
        if (locked) revert IsLocked();
        peer = peer_;
    }

    /// @notice Freeze the trust setup for good: pin `receiveLibrary` (so a change of LayerZero's
    ///         default cannot drop our DVN config), remove the delegate and freeze the peer.
    ///         After this, only the configured DVN set can get a report accepted. Owner only.
    function lock(address receiveLibrary) external {
        if (msg.sender != owner) revert NotOwner();
        if (locked) revert IsLocked();
        if (peer == bytes32(0)) revert BadOrigin();
        endpoint.setReceiveLibrary(address(this), srcEid, receiveLibrary, 0);
        endpoint.setDelegate(address(0));
        locked = true;
        emit Locked(receiveLibrary);
    }

    /// @notice Newest stored report for `rigId` (zero if none).
    function latest(uint256 rigId) external view returns (RigReport memory) {
        return _latest[rigId];
    }

    /// @inheritdoc IRigFeed
    function consume(uint256 rigId, bytes calldata) external view returns (RigReport memory r) {
        r = _latest[rigId];
        if (r.observedAt == 0) revert NoReport();
    }

    /// @inheritdoc ILzReceiver
    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return peer != bytes32(0) && origin.srcEid == srcEid && origin.sender == peer;
    }

    /// @inheritdoc ILzReceiver
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0; // unordered delivery
    }

    /// @inheritdoc ILzReceiver
    function lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        external
        payable
    {
        if (msg.sender != address(endpoint)) revert NotEndpoint();
        if (peer == bytes32(0) || origin.srcEid != srcEid || origin.sender != peer) revert BadOrigin();
        RigReport[] memory rs = abi.decode(message, (RigReport[]));
        for (uint256 i; i < rs.length; i++) {
            RigReport memory r = rs[i];
            bool newer = r.observedAt > _latest[r.rigId].observedAt;
            if (newer) _latest[r.rigId] = r;
            emit Reported(r.rigId, r.observedAt, newer);
        }
    }
}
