// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SPIKE ONLY. Fail-closed consumer of a TapeOut circuit (TAP-02 eval semantics).
///         - gas-capped STATICCALL to circuits.eval(id, inputs)
///         - strict decoding: ABI bytes of exactly ceil(nOut/8) with zero padding bits
///         - any failure => ok=false (caller must treat as "deny")
library CircuitGate {
    bytes4 internal constant EVAL = 0x934d06ea; // eval(uint256,bytes)

    function evalCapped(address circuits, uint256 id, bytes memory inputs, uint256 gasCap, uint256 nOut)
        internal
        view
        returns (bool ok, bytes memory out, uint256 gasUsed)
    {
        uint256 g0 = gasleft();
        (bool success, bytes memory ret) = circuits.staticcall{gas: gasCap}(abi.encodeWithSelector(EVAL, id, inputs));
        gasUsed = g0 - gasleft();
        if (!success) return (false, "", gasUsed);
        // ABI bytes: offset(32) + length(32) + data padded to 32.
        if (ret.length < 64) return (false, "", gasUsed);
        uint256 off;
        uint256 len;
        assembly {
            off := mload(add(ret, 32))
            len := mload(add(ret, 64))
        }
        uint256 want = (nOut + 7) / 8;
        if (off != 32 || len != want || ret.length < 64 + len) return (false, "", gasUsed);
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = ret[64 + i];
        }
        // padding bits of the last byte must be zero
        uint256 used = nOut % 8;
        if (used != 0 && (uint8(out[len - 1]) >> used) != 0) return (false, "", gasUsed);
        ok = true;
    }

    /// Convenience: 1-output policy circuit. Returns allow only if the call succeeded, decoded strictly, and bit0 == 1.
    function allow(address circuits, uint256 id, bytes memory inputs, uint256 gasCap) internal view returns (bool) {
        (bool ok, bytes memory out,) = evalCapped(circuits, id, inputs, gasCap, 1);
        return ok && (uint8(out[0]) & 1) == 1;
    }
}
