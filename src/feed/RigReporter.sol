// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OAppCore} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppCore.sol";
import {OAppSender, MessagingFee, MessagingReceipt} from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";
import {RigReport} from "../interfaces/IRigFeed.sol";
import {IRigVaultBsc, IPodMining} from "../interfaces/IBsc.sol";
import {BscRigReader} from "./BscRigReader.sol";
import {FeedLock} from "./FeedLock.sol";

/// @notice BSC side of the rig data feed (SPEC §6, SPEC-PHASE3 §5.3). Anyone pays the LayerZero fee
///         to read up to 16 rigs on BSC and send their reports to `RigFeedReceiver` on X Layer. The
///         data is read on-chain, so no key of ours vouches for it.
/// @dev After `lock` the contract has no owner and no delegate: the peer, the send library and the
///      DVN config can never change again, and only the DVN set carries the reports.
contract RigReporter is OAppSender {
    uint256 public constant MAX_RIGS = 16;
    /// @notice Executor gas for `lzReceive` on X Layer: `BASE_GAS + GAS_PER_RIG × n`.
    uint128 public constant BASE_GAS = 60_000;
    uint128 public constant GAS_PER_RIG = 130_000; // 16 rigs measured at 1.60M on a fork: 2.14M keeps 34% headroom

    /// @notice X Layer endpoint id (30274).
    uint32 public immutable dstEid;
    IRigVaultBsc public immutable vault;
    IPodMining public immutable pod;
    /// @notice The BEM bridge's OFT adapter on BSC, whose DVN config `lock` requires us to mirror.
    address public immutable bemRef;

    event Pushed(bytes32 indexed guid, uint256 rigs, uint256 fee);
    event Locked(address sendLibrary);

    error BadBatch();
    error WrongEid(uint32 eid);
    error ZeroAddress();
    error LibraryNotPinned();
    error NotBemLibrary();
    error RenounceDisabled();

    /// @param endpoint_ LayerZero EndpointV2 on BSC.
    /// @param owner_ Owner and endpoint delegate until `lock`.
    /// @param dstEid_ X Layer endpoint id.
    /// @param vault_ The rig vault.
    /// @param pod_ PodMining.
    /// @param bemRef_ The BEM OFT adapter on BSC.
    constructor(
        address endpoint_,
        address owner_,
        uint32 dstEid_,
        IRigVaultBsc vault_,
        IPodMining pod_,
        address bemRef_
    ) OAppCore(endpoint_, owner_) Ownable(owner_) {
        if (address(vault_) == address(0) || address(pod_) == address(0) || bemRef_ == address(0)) {
            revert ZeroAddress();
        }
        dstEid = dstEid_;
        vault = vault_;
        pod = pod_;
        bemRef = bemRef_;
    }

    // ───────────────────────── push

    /// @notice Read `rigIds` on BSC now and send their reports to X Layer. `msg.value` is the fee;
    ///         the endpoint refunds any excess to the caller (a contract caller without `receive()`
    ///         must send exactly `quote`). Permissionless.
    /// @param rigIds 1 to 16 rig ids.
    /// @return guid The LayerZero message id.
    function push(uint256[] calldata rigIds) external payable returns (bytes32 guid) {
        uint256 n = rigIds.length;
        MessagingReceipt memory rc =
            _lzSend(dstEid, _message(rigIds), options(n), MessagingFee(msg.value, 0), msg.sender);
        emit Pushed(rc.guid, n, rc.fee.nativeFee);
        return rc.guid;
    }

    /// @notice Native fee to push `rigIds` now.
    /// @param rigIds 1 to 16 rig ids.
    function quote(uint256[] calldata rigIds) external view returns (uint256) {
        return _quote(dstEid, _message(rigIds), options(rigIds.length), false).nativeFee;
    }

    /// @notice Executor options for `n` rigs: type 3, `lzReceive` gas only.
    /// @param n Number of rigs in the message.
    function options(uint256 n) public pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast) n <= 16 wherever a message is built
        uint128 gas = BASE_GAS + GAS_PER_RIG * uint128(n);
        return abi.encodePacked(uint16(3), uint8(1), uint16(17), uint8(1), gas);
    }

    function _message(uint256[] calldata rigIds) internal view returns (bytes memory) {
        uint256 n = rigIds.length;
        if (n == 0 || n > MAX_RIGS) revert BadBatch();
        RigReport[] memory rs = new RigReport[](n);
        for (uint256 i; i < n; ++i) {
            rs[i] = BscRigReader.read(vault, pod, rigIds[i]);
        }
        return abi.encode(rs);
    }

    // ───────────────────────── setup and lock (SPEC-PHASE3 §5.5)

    /// @notice Set the X Layer receiver. Only for `dstEid`. Owner only, before `lock`.
    /// @param eid Must be `dstEid`.
    /// @param peer The receiver as bytes32.
    function setPeer(uint32 eid, bytes32 peer) public override onlyOwner {
        if (eid != dstEid) revert WrongEid(eid);
        _setPeer(eid, peer);
    }

    /// @notice Freeze the trust setup for good: pin `lib` as the send library, require the DVN config
    ///         to mirror the BEM bridge's with no DEFAULT field, remove the delegate and end ownership.
    ///         Owner only, once.
    /// @param lib The send library (the one the BEM adapter uses).
    function lock(address lib) external onlyOwner {
        if (lib == address(0)) revert ZeroAddress();
        _getPeerOrRevert(dstEid);
        if (endpoint.getSendLibrary(bemRef, dstEid) != lib) revert NotBemLibrary();
        endpoint.setSendLibrary(address(this), dstEid, lib);
        if (
            endpoint.getSendLibrary(address(this), dstEid) != lib
                || endpoint.isDefaultSendLibrary(address(this), dstEid)
        ) {
            revert LibraryNotPinned();
        }
        FeedLock.requireMirrored(lib, address(this), bemRef, dstEid);
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

interface IDelegates {
    function delegates(address oapp) external view returns (address);
}
