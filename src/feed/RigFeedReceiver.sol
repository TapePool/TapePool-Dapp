// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OAppCore} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppCore.sol";
import {OAppReceiver, Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppReceiver.sol";
import {IRigFeed, RigReport} from "../interfaces/IRigFeed.sol";
import {FeedLock} from "./FeedLock.sol";
import {IDelegates} from "./RigReporter.sol";

/// @notice X Layer side of the rig data feed (SPEC §6, SPEC-PHASE3 §5.4): accepts report batches
///         from `RigReporter` on BSC and keeps the newest report per rig. Agents read impairment
///         evidence from it and `CreditPolicy` reads borrow-time flags from it.
/// @dev Messages are unordered; an older or equal report never replaces a newer one. After `lock`
///      the contract has no owner and no delegate, so only the DVN set can get a report accepted.
contract RigFeedReceiver is OAppReceiver, IRigFeed {
    /// @notice Maximum tolerated BSC clock lead in seconds.
    uint256 public constant MAX_CLOCK_SKEW = 60;
    /// @notice BSC endpoint id (30102).
    uint32 public immutable srcEid;
    /// @notice The BEM OFT on X Layer, whose DVN config `lock` requires us to mirror.
    address public immutable bemRef;

    mapping(uint256 rigId => RigReport) internal _latest;

    event Reported(uint256 indexed rigId, uint64 observedAt, bool stored);
    event Locked(address receiveLibrary);

    error WrongEid(uint32 eid);
    error ZeroAddress();
    error LibraryNotPinned();
    error NotBemLibrary();
    error RenounceDisabled();

    /// @param endpoint_ LayerZero EndpointV2 on X Layer.
    /// @param owner_ Owner and endpoint delegate until `lock`.
    /// @param srcEid_ BSC endpoint id.
    /// @param bemRef_ The BEM OFT on X Layer.
    constructor(address endpoint_, address owner_, uint32 srcEid_, address bemRef_)
        OAppCore(endpoint_, owner_)
        Ownable(owner_)
    {
        if (bemRef_ == address(0)) revert ZeroAddress();
        srcEid = srcEid_;
        bemRef = bemRef_;
    }

    // ───────────────────────── IRigFeed

    /// @inheritdoc IRigFeed
    function latest(uint256 rigId) external view returns (RigReport memory report, bool ok) {
        report = _latest[rigId];
        ok = report.observedAt != 0;
    }

    // ───────────────────────── receive

    /// @dev The OApp base already checked that the endpoint calls and the sender is our peer.
    function _lzReceive(Origin calldata, bytes32, bytes calldata message, address, bytes calldata) internal override {
        RigReport[] memory rs = abi.decode(message, (RigReport[]));
        for (uint256 i; i < rs.length; ++i) {
            RigReport memory r = rs[i];
            bool newer = r.observedAt <= block.timestamp + MAX_CLOCK_SKEW && r.observedAt > _latest[r.rigId].observedAt;
            if (newer) _latest[r.rigId] = r;
            emit Reported(r.rigId, r.observedAt, newer);
        }
    }

    // ───────────────────────── setup and lock (SPEC-PHASE3 §5.5)

    /// @notice Set the BSC reporter. Only for `srcEid`. Owner only, before `lock`.
    /// @param eid Must be `srcEid`.
    /// @param peer The reporter as bytes32.
    function setPeer(uint32 eid, bytes32 peer) public override onlyOwner {
        if (eid != srcEid) revert WrongEid(eid);
        _setPeer(eid, peer);
    }

    /// @notice Freeze the trust setup for good: pin `lib` as the receive library, require the DVN
    ///         config to mirror the BEM bridge's with no DEFAULT field, remove the delegate and end
    ///         ownership. Owner only, once.
    /// @param lib The receive library (the one the BEM OFT uses).
    function lock(address lib) external onlyOwner {
        if (lib == address(0)) revert ZeroAddress();
        _getPeerOrRevert(srcEid);
        (address bemLib,) = endpoint.getReceiveLibrary(bemRef, srcEid);
        if (bemLib != lib) revert NotBemLibrary();
        endpoint.setReceiveLibrary(address(this), srcEid, lib, 0);
        (address pinned, bool isDefault) = endpoint.getReceiveLibrary(address(this), srcEid);
        if (pinned != lib || isDefault) revert LibraryNotPinned();
        FeedLock.requireMirrored(lib, address(this), bemRef, srcEid);
        endpoint.setDelegate(address(0));
        _transferOwnership(address(0));
        emit Locked(lib);
    }

    /// @notice Disabled: renouncing before `lock` would leave the delegate able to change the DVN
    ///         config. Ownership ends only through `lock`.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice True once `lock` has run: no owner and no endpoint delegate.
    function locked() external view returns (bool) {
        return owner() == address(0) && IDelegates(address(endpoint)).delegates(address(this)) == address(0);
    }
}
