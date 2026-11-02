// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double of a TapeOut Circuits contract: stores NAND-only TAP-02 netlists and evaluates
///         them in Solidity (inputs and outputs LSB first, the last `nOut` signals are the outputs).
///         It shares our encoding assumptions, so it is not the proof; the fork test against the real
///         `eval` is. `Mode` makes it misbehave the ways an upgraded or hostile processor could.
contract NandCircuits {
    enum Mode {
        Normal,
        Invert, // flip output bit 0
        LongOutput, // two output bytes instead of one
        PaddingBits, // set an unused bit of the output byte
        BadOffset, // ABI offset 64 instead of 32
        Huge, // 64 KiB of return data
        Revert,
        BurnGas, // loop until out of gas
        Empty, // succeed with no return data
        ChangedNetlist, // netlist() returns different bytes
        ChangedInfo, // circuitInfo() reports one more gate
        ShortInfo // circuitInfo() returns three words
    }

    struct Circuit {
        bytes nl;
        uint32 nIn;
        uint32 nOut;
        uint32 gates;
    }

    mapping(uint256 => Circuit) internal _c;
    uint256 public nextId;
    Mode public mode;

    function setMode(Mode m) external {
        mode = m;
    }

    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external returns (uint256 id) {
        require(nl.length % 7 == 0, "NAND only");
        id = ++nextId;
        // forge-lint: disable-next-line(unsafe-typecast) test netlists are small
        _c[id] = Circuit({nl: nl, nIn: nIn, nOut: nOut, gates: uint32(nl.length / 7)});
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Circuit storage c = _c[id];
        require(c.nIn != 0, "no circuit");
        if (mode == Mode.ShortInfo) {
            assembly {
                mstore(0, 12)
                mstore(0x20, 1)
                mstore(0x40, 0)
                return(0, 0x60)
            }
        }
        return (c.nIn, c.nOut, 0, mode == Mode.ChangedInfo ? c.gates + 1 : c.gates);
    }

    function netlist(uint256 id) external view returns (bytes memory nl) {
        nl = _c[id].nl;
        if (mode == Mode.ChangedNetlist && nl.length != 0) nl[nl.length - 1] = bytes1(uint8(nl[nl.length - 1]) ^ 1);
    }

    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory) {
        Mode m = mode;
        if (m == Mode.Revert) revert("eval reverted");
        if (m == Mode.BurnGas) {
            uint256 x;
            while (true) {
                x++;
            }
        }
        if (m == Mode.Empty) {
            assembly {
                return(0, 0)
            }
        }
        if (m == Mode.Huge) return new bytes(65_536);
        bytes memory out = _run(_c[id], inputs);
        if (m == Mode.Invert) out[0] = bytes1(uint8(out[0]) ^ 1);
        if (m == Mode.LongOutput) return abi.encodePacked(out, bytes1(0));
        if (m == Mode.PaddingBits) out[0] = bytes1(uint8(out[0]) | 0x80);
        if (m == Mode.BadOffset) {
            uint256 b = uint8(out[0]);
            assembly {
                mstore(0, 64)
                mstore(0x20, 1)
                mstore(0x40, shl(248, b))
                return(0, 0x60)
            }
        }
        return out;
    }

    function _run(Circuit storage c, bytes calldata inputs) internal view returns (bytes memory out) {
        bytes memory nl = c.nl;
        uint256 nIn = c.nIn;
        uint256 n = 2 + nIn + c.gates;
        bool[] memory s = new bool[](n);
        s[1] = true;
        for (uint256 i; i < nIn; i++) {
            s[2 + i] = (i / 8 < inputs.length) && ((uint8(inputs[i / 8]) >> (i % 8)) & 1 == 1);
        }
        uint256 next = 2 + nIn;
        for (uint256 p; p < nl.length; p += 7) {
            require(uint8(nl[p]) == 0, "bad opcode");
            uint256 a = (uint256(uint8(nl[p + 1])) << 16) | (uint256(uint8(nl[p + 2])) << 8) | uint8(nl[p + 3]);
            uint256 b = (uint256(uint8(nl[p + 4])) << 16) | (uint256(uint8(nl[p + 5])) << 8) | uint8(nl[p + 6]);
            require(a < next && b < next, "future signal");
            s[next++] = !(s[a] && s[b]);
        }
        uint256 nOut = c.nOut;
        out = new bytes((nOut + 7) / 8);
        for (uint256 j; j < nOut; j++) {
            // forge-lint: disable-next-line(incorrect-shift,unsafe-typecast) one bit, at most 1 << 7
            if (s[n - nOut + j]) out[j / 8] = bytes1(uint8(out[j / 8]) | uint8(1 << (j % 8)));
        }
    }
}
