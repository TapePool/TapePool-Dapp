// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XLayerBase, console2} from "./XLayerBase.sol";

/// T0: can forge fork X Layer (chain 196) and run the EVM features the spike needs?
contract T0_ForkTest is XLayerBase {
    function test_T0_forkLatest() public {
        vm.createSelectFork("xlayer"); // latest
        assertEq(block.chainid, 196, "chain id");
        assertGt(block.number, 73_500_000, "block");
        console2.log("latest block", block.number);
        console2.log("timestamp", block.timestamp);
        console2.log("block gas limit", block.gaslimit);
        console2.log("basefee (wei)", block.basefee);
        assertGt(address(VOUCHER).code.length, 0, "voucher code");
        assertGt(address(BEM).code.length, 0, "BEM code");
        assertGt(address(ENDPOINT).code.length, 0, "endpoint code");
        assertGt(address(0x1f09DAeFA827f02CBb40967cc91b259763760761).code.length, 0, "factory code");
        assertEq(VOUCHER.vault(), RIG_VAULT_BSC);
        assertEq(VOUCHER.endpoint(), address(ENDPOINT));
        assertEq(VOUCHER.oft(), address(BEM));
    }

    function test_T0_pinnedForkAndPrecompiles() public {
        uint256 b = _fork();
        assertEq(block.number, b);
        // standard precompiles execute locally in revm; check they behave inside the fork
        (bool ok, bytes memory out) = address(0x02).staticcall("abc"); // sha256
        assertTrue(ok);
        assertEq(bytes32(out), sha256("abc"));
        (ok, out) = address(0x04).staticcall(hex"c0ffee"); // identity
        assertTrue(ok);
        assertEq(out, hex"c0ffee");
        // ecrecover with a known vector (vm.sign on a local key)
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA11CE, keccak256("x"));
        assertEq(ecrecover(keccak256("x"), v, r, s), vm.addr(0xA11CE));
        // bn256 add (0x06): G1 + G1
        (ok, out) = address(0x06).staticcall(abi.encode(uint256(1), uint256(2), uint256(1), uint256(2)));
        assertTrue(ok, "bn256add");
        // P256VERIFY (RIP-7212, 0x100): just report availability
        (ok, out) = address(0x100).staticcall(new bytes(160));
        console2.log("p256verify call ok", ok, "retlen", out.length);
        // PUSH0 / MCOPY / TSTORE (cancun) via the solc 0.8.24 cancun build: tstore round-trip
        uint256 t;
        assembly {
            tstore(1, 42)
            t := tload(1)
        }
        assertEq(t, 42);
    }
}
