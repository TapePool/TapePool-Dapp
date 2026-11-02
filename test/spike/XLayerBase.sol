// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IRigVoucher, ILzEndpointV2, IOFTLike, Origin} from "../../src/interfaces/IXLayer.sol";

/// Shared fork setup + a harness that reproduces the X Layer side of a TapeOut harvest.
/// LOCAL FORK ONLY: impersonation (vm.prank) and vm.deal never leave this process.
abstract contract XLayerBase is Test {
    // ── live X Layer (196) addresses
    IRigVoucher constant VOUCHER = IRigVoucher(0x9cfc959cd42B2e1d39a0d850c528210E818AE520);
    IOFTLike constant BEM = IOFTLike(0x60e62Efa9405d6873C5deaBD4E6CC91c25363952); // OFT == token
    ILzEndpointV2 constant ENDPOINT = ILzEndpointV2(0x1a44076050125825900e736c501f859c50fE728c);
    address constant RIG_VAULT_BSC = 0x48D43345656f0f9510dC3c06CBa99dFf597617C2; // composeFrom (BSC vault)
    address constant ADAPTER_BSC = 0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72; // OFT peer on BSC
    address constant LZ_EXECUTOR = 0xcCE466a522984415bC91338c232d98869193D46e; // executor seen in real compose tx
    address constant HOLDER_C905 = 0xC9059E0F59F40920E5BD24307eaa4DeFd81Df145; // holds ids 4..13
    uint32 constant BSC_EID = 30102;
    uint8 constant YIELD = 2;

    uint256 constant DEFAULT_FORK_BLOCK = 73_558_380;

    uint64 internal lzNonce; // next inbound nonce from the BSC adapter

    function _fork() internal returns (uint256 blockNo) {
        blockNo = vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK);
        vm.createSelectFork("xlayer", blockNo);
        lzNonce = ENDPOINT.inboundNonce(address(BEM), BSC_EID, _peer()) + 1;
    }

    function _peer() internal pure returns (bytes32) {
        return bytes32(uint256(uint160(ADAPTER_BSC)));
    }

    function _yieldBody(uint64 sendTime, address caller, uint256 id, uint256 amountLD, uint256 power)
        internal
        pure
        returns (bytes memory)
    {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory packed = new uint256[](1);
        ids[0] = id;
        packed[0] = (amountLD << 128) | power;
        return abi.encode(YIELD, sendTime, caller, uint256(0), ids, packed);
    }

    struct HarvestResult {
        bytes32 guid;
        bytes composeMsg;
        uint256 gasReceive;
        uint256 gasCompose;
        uint8 level; // 1 = verify(lib) + endpoint.lzReceive + endpoint.lzCompose (real path), 2 = pranked endpoint -> OFT.lzReceive
    }

    /// Reproduce a harvest landing on X Layer for one rig.
    /// Level 1 (faithful): only the DVN/receive-library `verify` step is impersonated; the
    ///   endpoint.lzReceive -> OFT._credit (mint) -> endpoint.sendCompose -> endpoint.lzCompose ->
    ///   RigVoucher.lzCompose chain runs as real code, and lzReceive/lzCompose are called permissionlessly.
    function _deliverHarvest(uint256 id, uint64 amountSD, uint64 sendTime, uint256 power)
        internal
        returns (HarvestResult memory r)
    {
        uint256 amountLD = uint256(amountSD) * 100; // 8 local decimals, 6 shared
        bytes memory body = _yieldBody(sendTime, address(0xCA11E5), id, amountLD, power);
        // OFT message: sendTo | amountSD | composeFrom | composeMsg   (OFTMsgCodec)
        bytes memory oftMsg = abi.encodePacked(
            bytes32(uint256(uint160(address(VOUCHER)))), amountSD, bytes32(uint256(uint160(RIG_VAULT_BSC))), body
        );
        uint64 nonce = lzNonce++;
        r.guid = keccak256(abi.encode("tape-pool-spike", nonce, id, sendTime));
        Origin memory o = Origin(BSC_EID, _peer(), nonce);

        (address lib,) = ENDPOINT.getReceiveLibrary(address(BEM), BSC_EID);
        vm.prank(lib);
        ENDPOINT.verify(o, address(BEM), keccak256(abi.encodePacked(r.guid, oftMsg)));

        // permissionless delivery, executed from the real LZ executor address for realism
        uint256 g = gasleft();
        vm.prank(LZ_EXECUTOR);
        ENDPOINT.lzReceive(o, address(BEM), r.guid, oftMsg, "");
        r.gasReceive = g - gasleft();
        r.level = 1;

        // compose message as OFTComposeMsgCodec.encode: nonce | srcEid | amountLD | composeFrom | composeMsg
        r.composeMsg = abi.encodePacked(nonce, BSC_EID, amountLD, bytes32(uint256(uint160(RIG_VAULT_BSC))), body);
        assertEq(
            ENDPOINT.composeQueue(address(BEM), address(VOUCHER), r.guid, 0),
            keccak256(r.composeMsg),
            "compose not queued"
        );

        g = gasleft();
        vm.prank(LZ_EXECUTOR);
        ENDPOINT.lzCompose(address(BEM), address(VOUCHER), r.guid, 0, r.composeMsg, "");
        r.gasCompose = g - gasleft();
    }
}
