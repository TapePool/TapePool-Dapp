// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NetlistBuilder} from "./NetlistBuilder.sol";

/// @notice Credit policy circuit v1 (SPEC §8, SPEC-PHASE3 §2): the netlist that is taped out on
///         X Layer, its Solidity reference model, and the input encoding.
///
/// Inputs (12 bits, LSB first within each byte):
///   0-1  term code (0 = 7 d, 1 = 14 d, 2 = reserved, 3 = invalid)
///   2-6  debt bucket b, 5 bits
///   7    fresh       8  unimpaired       9  processorOk       10  ageOk       11  screened
/// Output (1 bit): allow = in7 & in8 & in9 & in10 & in11 & ((t == 0 & b <= 17) | (t == 1 & b <= 16))
library PolicyV1 {
    using NetlistBuilder for NetlistBuilder.Netlist;

    uint32 internal constant N_IN = 12;
    uint32 internal constant N_OUT = 1;
    uint32 internal constant N_STATE = 0;

    /// @dev Golden values of `build()`, fixed by the first build and asserted by tests and the
    ///      tape-out script. The mainnet circuit must carry exactly these.
    uint32 internal constant GATES = 44;
    bytes32 internal constant NETLIST_HASH = 0xbe898b7aa5665c61f151a6121da1456431d3d9b2de3dc6e325e767af29248b38;

    uint256 internal constant VECTORS = 4096;

    /// @notice The NAND netlist of policy v1 and its gate count. The last record is the output.
    function build() internal pure returns (bytes memory nl, uint32 gates) {
        // forge-lint: disable-next-line(unsafe-typecast) N_IN is 12
        NetlistBuilder.Netlist memory n = NetlistBuilder.create(uint24(N_IN));

        uint24[] memory b = new uint24[](5);
        for (uint24 i; i < 5; i++) {
            b[i] = NetlistBuilder.input(2 + i);
        }
        uint24 t0 = NetlistBuilder.input(0);
        uint24 nt0 = n.not_(t0);
        uint24 nt1 = n.not_(NetlistBuilder.input(1));
        uint24 term7 = n.and_(n.and_(nt1, nt0), n.leConst(b, 17)); // 7 d: debt <= 85% of expected
        uint24 term14 = n.and_(n.and_(nt1, t0), n.leConst(b, 16)); // 14 d: debt <= 80% of expected
        uint24 termOk = n.or_(term7, term14);

        uint24 flags = NetlistBuilder.input(7);
        for (uint24 i = 8; i < 12; i++) {
            flags = n.and_(flags, NetlistBuilder.input(i));
        }
        n.and_(flags, termOk); // last record = the single output
        return (n.data, n.gates);
    }

    /// @notice Reference model of the circuit over the 12-bit input `v`. False for `v >= 4096`.
    function expected(uint256 v) internal pure returns (bool) {
        if (v >= VECTORS) return false;
        uint256 t = v & 3;
        uint256 b = (v >> 2) & 31;
        bool flags = ((v >> 7) & 31) == 31;
        return flags && ((t == 0 && b <= 17) || (t == 1 && b <= 16));
    }

    /// @notice The 2-byte `eval` input for `v`: byte 0 = bits 0-7, byte 1 bits 0-3 = bits 8-11.
    function encode(uint256 v) internal pure returns (bytes memory) {
        // forge-lint: disable-next-line(unsafe-typecast) both values are masked to 8 bits or less
        return abi.encodePacked(uint8(v & 0xff), uint8((v >> 8) & 0x0f));
    }
}
