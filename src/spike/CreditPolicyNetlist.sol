// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NetlistBuilder} from "./NetlistBuilder.sol";

/// @notice SPIKE ONLY. Toy "credit policy" as a TAP-02 NAND netlist.
/// Inputs (9 bits, LSB-first):
///   bit0-1  term code   (0 = 30d, 1 = 60d, 2 = 90d, 3 = invalid)
///   bit2-5  DTO bucket  (debt / expected daily base yield, in 4-day buckets, 0..15)
///   bit6    attestation fresh
///   bit7    no rescue/upgrade impairment flag
///   bit8    processor allowlisted
/// Output (1 bit): allow = f6 & f7 & f8 & ( t==0 & dto<=6 | t==1 & dto<=4 | t==2 & dto<=2 )
library CreditPolicyNetlist {
    using NetlistBuilder for NetlistBuilder.NL;

    uint32 internal constant N_IN = 9;
    uint32 internal constant N_OUT = 1;

    function build() internal pure returns (bytes memory nl, uint32 gates) {
        NetlistBuilder.NL memory n = NetlistBuilder.create(uint24(N_IN));
        uint24 ok = _termOk(n);
        uint24 flags = n.and_(n.and_(NetlistBuilder.input(6), NetlistBuilder.input(7)), NetlistBuilder.input(8));
        n.and_(flags, ok); // last element = the single output
        return (n.data, n.gates);
    }

    function _termOk(NetlistBuilder.NL memory n) private pure returns (uint24) {
        uint24[] memory d = new uint24[](4);
        for (uint24 i; i < 4; i++) {
            d[i] = NetlistBuilder.input(2 + i);
        }
        uint24 nt0 = n.not_(NetlistBuilder.input(0));
        uint24 nt1 = n.not_(NetlistBuilder.input(1));
        uint24 a = n.and_(n.and_(nt0, nt1), n.leConst(d, 6)); // term 0 (30d): dto bucket <= 6
        uint24 b = n.and_(n.and_(NetlistBuilder.input(0), nt1), n.leConst(d, 4)); // term 1 (60d): <= 4
        uint24 c = n.and_(n.and_(nt0, NetlistBuilder.input(1)), n.leConst(d, 2)); // term 2 (90d): <= 2
        return n.or_(n.or_(a, b), c);
    }

    /// Reference model (Solidity) used to check the on-chain truth table.
    function expected(uint256 v) internal pure returns (bool) {
        uint256 t = v & 3;
        uint256 dto = (v >> 2) & 15;
        bool flags = ((v >> 6) & 7) == 7;
        bool ok = (t == 0 && dto <= 6) || (t == 1 && dto <= 4) || (t == 2 && dto <= 2);
        return flags && ok;
    }

    function encode(uint256 v) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(v & 0xff), uint8((v >> 8) & 0xff));
    }
}
