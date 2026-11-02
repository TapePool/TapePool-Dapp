// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SPIKE ONLY. Builds a TAP-02 netlist (header-less, big-endian, u24 signal indices)
///         made only of NAND records (opcode 0x00, 7 bytes). Signals: 0 = const0, 1 = const1,
///         2..2+nIn-1 = inputs, then one new signal per NAND in record order.
library NetlistBuilder {
    struct NL {
        bytes data;
        uint24 next; // index of the next signal to be produced
        uint32 gates;
    }

    uint24 internal constant ZERO = 0;
    uint24 internal constant ONE = 1;

    function create(uint24 nIn) internal pure returns (NL memory n) {
        n.next = 2 + nIn;
    }

    function input(uint24 i) internal pure returns (uint24) {
        return 2 + i;
    }

    function nand(NL memory n, uint24 a, uint24 b) internal pure returns (uint24 s) {
        require(a < n.next && b < n.next, "future signal");
        n.data = abi.encodePacked(n.data, uint8(0), a, b);
        s = n.next;
        n.next += 1;
        n.gates += 1;
    }

    function not_(NL memory n, uint24 a) internal pure returns (uint24) {
        return nand(n, a, a);
    }

    function and_(NL memory n, uint24 a, uint24 b) internal pure returns (uint24) {
        return not_(n, nand(n, a, b));
    }

    function or_(NL memory n, uint24 a, uint24 b) internal pure returns (uint24) {
        return nand(n, not_(n, a), not_(n, b));
    }

    /// value(bits) <= k, bits LSB-first. Built MSB -> LSB, constant-folded where possible.
    function leConst(NL memory n, uint24[] memory bits, uint256 k) internal pure returns (uint24 r) {
        r = ONE; // empty suffix: equal => "<=" holds
        for (uint256 i; i < bits.length; i++) {
            // process from LSB upward: le_i = (k_i==1) ? (!d_i | le_{i-1}) : (!d_i & le_{i-1})
            if ((k >> i) & 1 == 1) {
                if (r != ONE) r = nand(n, bits[i], not_(n, r)); // !d | r == NAND(d, !r)
            } else {
                uint24 nd = not_(n, bits[i]);
                r = (r == ONE) ? nd : and_(n, nd, r);
            }
        }
    }
}
