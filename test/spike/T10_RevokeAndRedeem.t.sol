// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPodMining, IRigVaultBsc, Miner} from "../../src/interfaces/IBsc.sol";

interface IPodClaim {
    function claim(bytes32 key) external;
    function claimMany(bytes32[] calldata keys) external;
}

interface IVaultCompose {
    function lzCompose(address from, bytes32 guid, bytes calldata message, address executor, bytes calldata extra)
        external
        payable;
}

/// A contract with no code paths at all: no ERC-721 receiver hook, no way to move what it gets.
contract DumbReceiver {}

/// T10 (DERISK Q4, Q5), LOCAL BSC forks only; skips without `BSC_RPC` (an archive endpoint).
/// Q4: a revocation does not forfeit pending BEM. PodMining settles it to the circuit's owner inside the
///     `challenge` transaction (for a bridged rig: its vault cell, so the next harvest forwards it to the
///     voucher holder); the challenger gets nothing; afterwards `claim` reverts and `claimMany` skips
///     the key, so a revoked rig never breaks a harvest batch.
/// Q5: the vault's redeem landing (`lzCompose`) delivers to any BSC address, contracts included: BEM by
///     `safeTransfer` and the circuit by plain `transferFrom`, so no receiver hook is needed. Mining
///     continues for the new owner, so a contract `to` must itself be able to move BEM and the circuit.
contract T10_RevokeAndRedeemTest is Test {
    IPodMining constant POD = IPodMining(0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46);
    IRigVaultBsc constant VAULT = IRigVaultBsc(0x48D43345656f0f9510dC3c06CBa99dFf597617C2);
    IERC20 constant BEM = IERC20(0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a);
    address constant ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c; // LayerZero EndpointV2 on BSC
    address constant ADAPTER = 0xa84B8D3893De6e9922f2B29bE1e1b115845F5E72; // BEM OFT adapter on BSC
    address constant VOUCHER = 0x9cfc959cd42B2e1d39a0d850c528210E818AE520; // RIG voucher on X Layer
    uint32 constant XLAYER_EID = 30274;
    bytes4 constant NOMN = 0x5f9bb3be; // Nomn(): this miner is not mining
    uint8 constant ACTIVE = 1;
    uint8 constant REVOKED = 2;

    /// Revocation #12 (tx 0x390b9b73…bd67a, block 124,688,916): miner, and the challenge calldata as sent.
    uint256 constant REVOKE_BLOCK = 124_688_916;
    bytes32 constant REVOKED_KEY = 0xcb0c4e092d655e345dff50e4d2d76ebbd3eaeec8824bf763f1fb250341243930;
    bytes constant REVOKE_CALL =
        hex"2d33823acb0c4e092d655e345dff50e4d2d76ebbd3eaeec8824bf763f1fb250341243930000000000000000000000000000000000000000000000000000000000000009f00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000002f3df00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000866bdaff3c779bb3b6203b39398d8af5dab3d2a2534f7183cf0664989c8aeaffba48ad11545dc52f181fb78af94582672c4a7243b42424a8bf2ed0bf418fe1e0d05263f451cd0639bc38ed586d408535ba71673252302c0124da9108a992f0c32571638ccaab7d7b5bcd92fd56a67f9162c92388deac703762036727173cc81865177239a488d69f5c53553008dbd6966c465dbd16b79d31fd1dd8d8987ea1ac91a4248dac21064ff40ff6defa7ce30d3f02bc8f97224b2d1d200a81985b384d9be90049748b0f46c20faa38f5b1842ab2bfcdbff56b57ba5c8adc9b73b682b828ea4323f6316adfff7fb90f5de70b2dc37abcdf60e47173093fe6ace11226731";

    uint256 constant BSC_BLOCK = 128_369_002; // the feed tests' block
    uint256 constant RIG = 16; // the demo rig

    string internal rpc;

    function setUp() public {
        rpc = vm.envOr("BSC_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
    }

    // ───────────────────────── Q4

    function test_T10_revocation_settles_pending_to_the_circuit_owner() public {
        vm.createSelectFork(rpc, REVOKE_BLOCK - 1);
        Miner memory m = POD.getMiner(REVOKED_KEY);
        assertEq(m.status, ACTIVE, "active one block before");
        address owner = IERC721(m.circuits).ownerOf(m.circuitId);
        uint256 pending = POD.pending(REVOKED_KEY);
        assertGt(pending, 0, "pending BEM before the revocation");
        uint256 ownerBefore = BEM.balanceOf(owner);

        address challenger = makeAddr("any-challenger"); // no privilege needed
        vm.prank(challenger);
        (bool ok,) = address(POD).call(REVOKE_CALL);
        assertTrue(ok, "the historical challenge revokes again on the fork");

        Miner memory after_ = POD.getMiner(REVOKED_KEY);
        assertEq(after_.status, REVOKED, "revoked");
        assertEq(after_.verifWeight, 0, "no more power");
        assertEq(POD.pending(REVOKED_KEY), 0, "nothing left pending");
        // the settlement accrues up to the revocation itself, so it is pending plus a few seconds of output
        // (1,248,277 raw here, the same as the historical transaction)
        uint256 paid = BEM.balanceOf(owner) - ownerBefore;
        assertGe(paid, pending, "pending paid to the circuit owner in the same tx");
        assertLe(paid, pending + pending / 100, "and only that");
        assertEq(BEM.balanceOf(challenger), 0, "the challenger gets no BEM");

        vm.expectRevert(NOMN);
        IPodClaim(address(POD)).claim(REVOKED_KEY);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = REVOKED_KEY;
        IPodClaim(address(POD)).claimMany(keys); // skips it, does not revert
    }

    function test_T10_a_revoked_key_never_breaks_a_harvest_batch() public {
        vm.createSelectFork(rpc, BSC_BLOCK);
        (address circuits, uint256 circuitId) = VAULT.rigs(RIG);
        bytes32 live = POD.minerKey(circuits, circuitId);
        address cell = VAULT.cellOf(live);
        uint256 before = BEM.balanceOf(cell);
        assertGt(POD.pending(live), 0, "the demo rig has pending BEM");
        assertEq(POD.getMiner(REVOKED_KEY).status, REVOKED, "revoked since block 124,688,916");

        // the vault's harvest calls claimMany on its whole batch: a revoked key in it is skipped
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = REVOKED_KEY;
        keys[1] = live;
        IPodClaim(address(POD)).claimMany(keys);
        assertGt(BEM.balanceOf(cell), before, "the live rig was still claimed into its cell");
    }

    // ───────────────────────── Q5

    /// The message the OFT adapter hands to the vault's `lzCompose` when a voucher is redeemed on X Layer.
    function _redeemMessage(uint256 id, address to, uint256 bond) internal pure returns (bytes memory) {
        return abi.encodePacked(uint64(1), XLAYER_EID, bond, bytes32(uint256(uint160(VOUCHER))), abi.encode(id, to));
    }

    function _land(uint256 id, address to, uint256 bond) internal {
        vm.prank(ADAPTER); // the adapter credits the bond to the vault before the compose runs
        BEM.transfer(address(VAULT), bond);
        vm.prank(ENDPOINT);
        IVaultCompose(address(VAULT))
            .lzCompose(ADAPTER, keccak256("redeem"), _redeemMessage(id, to, bond), address(0), "");
    }

    function test_T10_redeem_lands_on_a_contract_without_any_receiver_hook() public {
        vm.createSelectFork(rpc, BSC_BLOCK);
        DumbReceiver to = new DumbReceiver();
        (address circuits, uint256 circuitId) = VAULT.rigs(RIG);
        bytes32 key = POD.minerKey(circuits, circuitId);
        uint256 swept = BEM.balanceOf(VAULT.cellOf(key));
        uint256 bond = 9_900;

        _land(RIG, address(to), bond);

        assertEq(IERC721(circuits).ownerOf(circuitId), address(to), "the circuit moved to the contract");
        assertEq(BEM.balanceOf(address(to)), swept + bond, "cell BEM and the bond moved to the contract");
        (address gone,) = VAULT.rigs(RIG);
        assertEq(gone, address(0), "the vault forgot the rig");

        // mining continues for the new owner: anyone's claim pays the contract, which cannot move it
        assertEq(POD.getMiner(key).status, ACTIVE, "still mining after the redeem");
        vm.warp(block.timestamp + 1 days);
        uint256 held = BEM.balanceOf(address(to));
        vm.prank(makeAddr("anyone"));
        IPodClaim(address(POD)).claim(key);
        assertGt(BEM.balanceOf(address(to)), held, "rewards accrue to the contract owner");
    }

    function test_T10_redeem_of_a_rescued_rig_fails_on_bsc() public {
        vm.createSelectFork(rpc, BSC_BLOCK);
        vm.prank(VAULT.owner());
        VAULT.rescue(RIG, address(0xBEEF));
        vm.prank(ADAPTER);
        BEM.transfer(address(VAULT), 9_900);
        vm.prank(ENDPOINT);
        vm.expectRevert(bytes4(keccak256("UnknownRig()")));
        IVaultCompose(address(VAULT))
            .lzCompose(ADAPTER, keccak256("redeem"), _redeemMessage(RIG, address(0xCAFE), 9_900), address(0), "");
    }
}
