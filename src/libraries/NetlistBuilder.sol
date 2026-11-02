// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Builds a TAP-02 netlist out of NAND records only (opcode 0x00, two `u24` big-endian
///         operands, 7 bytes each). Signals: 0 = const 0, 1 = const 1, `2 .. 2 + nIn - 1` = inputs,
///         then one new signal per NAND in record order. The last record's signal is the output.
library NetlistBuilder {
    struct Netlist {
        bytes data;
        uint24 next; // index of the next signal to be produced
        uint32 gates;
    }

    uint24 internal constant ZERO = 0;
    uint24 internal constant ONE = 1;

    error FutureSignal(uint24 a, uint24 b, uint24 next);

    /// @notice Empty netlist with `nIn` inputs.
    function create(uint24 nIn) internal pure returns (Netlist memory n) {
        n.next = 2 + nIn;
    }

    /// @notice Signal index of input `i`.
    function input(uint24 i) internal pure returns (uint24) {
        return 2 + i;
    }

    /// @notice Append `NAND(a, b)` and return its signal.
    function nand(Netlist memory n, uint24 a, uint24 b) internal pure returns (uint24 s) {
        if (a >= n.next || b >= n.next) revert FutureSignal(a, b, n.next);
        n.data = abi.encodePacked(n.data, uint8(0), a, b);
        s = n.next;
        n.next += 1;
        n.gates += 1;
    }

    function not_(Netlist memory n, uint24 a) internal pure returns (uint24) {
        return nand(n, a, a);
    }

    function and_(Netlist memory n, uint24 a, uint24 b) internal pure returns (uint24) {
        return not_(n, nand(n, a, b));
    }

    function or_(Netlist memory n, uint24 a, uint24 b) internal pure returns (uint24) {
        return nand(n, not_(n, a), not_(n, b));
    }

    /// @notice `value(bits) <= k`, `bits` LSB first. Built from the LSB up and constant-folded, so it
    ///         returns the constant `ONE` only when every value fits (`k >= 2^len - 1`).
    function leConst(Netlist memory n, uint24[] memory bits, uint256 k) internal pure returns (uint24 r) {
        r = ONE; // empty suffix: equal, so "<=" holds
        for (uint256 i; i < bits.length; i++) {
            // le_i = (k_i == 1) ? (!d_i | le_{i-1}) : (!d_i & le_{i-1})
            if ((k >> i) & 1 == 1) {
                if (r != ONE) r = nand(n, bits[i], not_(n, r)); // !d | r == NAND(d, !r)
            } else {
                uint24 nd = not_(n, bits[i]);
                r = (r == ONE) ? nd : and_(n, nd, r);
            }
        }
    }
}
