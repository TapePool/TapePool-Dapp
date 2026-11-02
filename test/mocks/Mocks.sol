// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IRigFeed, RigReport} from "../../src/interfaces/IRigFeed.sol";
import {ICreditPolicy, Reasons} from "../../src/interfaces/ICreditPolicy.sol";
import {CreditMath} from "../../src/libraries/CreditMath.sol";

/// BEM stand-in: plain ERC-20 with 8 decimals, like the BEM OFT.
contract MockBEM is ERC20 {
    constructor() ERC20("BEM", "BEM") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// RIG voucher stand-in: ERC-721 with the `rigs(id)` record and switchable transfer failures.
contract MockVoucher is ERC721 {
    enum Mode {
        Normal,
        Revert,
        BurnGas,
        Lie // reports success without moving the token
    }

    struct Rig {
        address circuits;
        uint64 syncedAt;
        uint256 circuitId;
        uint256 power;
    }

    address public immutable bem;
    mapping(uint256 => Rig) internal _rigs;
    mapping(uint256 => bool) public blocked; // per-id transfer failure
    Mode public mode;
    bool public badRigs; // `rigs(id)` answers with one word only, like a changed ABI after an upgrade

    constructor(address bem_) ERC721("RIG", "RIG") {
        bem = bem_;
    }

    /// Bridge-style mint: `_mint`, no receiver hook (spike T1).
    function mint(address to, uint256 id, uint256 power) external {
        _mint(to, id);
        _rigs[id] = Rig(address(0xC1C), uint64(block.timestamp), id + 1000, power);
    }

    function setRig(uint256 id, uint64 syncedAt, uint256 power) external {
        _rigs[id].syncedAt = syncedAt;
        _rigs[id].power = power;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setBlocked(uint256 id, bool b) external {
        blocked[id] = b;
    }

    function setBadRigs(bool b) external {
        badRigs = b;
    }

    function burn(uint256 id) external {
        _burn(id);
    }

    function rigs(uint256 id) external view returns (address, uint64, uint256, uint256) {
        if (badRigs) {
            assembly {
                mstore(0, 1)
                return(0, 0x20)
            }
        }
        Rig memory r = _rigs[id];
        return (r.circuits, r.syncedAt, r.circuitId, r.power);
    }

    function transferFrom(address from, address to, uint256 id) public override {
        if (mode == Mode.Revert || blocked[id]) revert("blocked");
        if (mode == Mode.BurnGas) {
            while (true) {}
        }
        if (mode == Mode.Lie) return;
        super.transferFrom(from, to, id);
    }
}

/// Feed stand-in: stores whatever report a test sets.
contract MockRigFeed is IRigFeed {
    mapping(uint256 => RigReport) internal _reports;
    mapping(uint256 => bool) internal _ok;
    bool public broken;

    function set(RigReport memory r) external {
        _reports[r.rigId] = r;
        _ok[r.rigId] = true;
    }

    function setAt(uint256 id, RigReport memory r) external {
        _reports[id] = r;
        _ok[id] = true;
    }

    function clear(uint256 id) external {
        delete _reports[id];
        _ok[id] = false;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latest(uint256 rigId) external view returns (RigReport memory, bool) {
        require(!broken, "feed down");
        return (_reports[rigId], _ok[rigId]);
    }
}

/// Credit policy stand-in. Sizes debt with `CreditMath` from the feed's reports, like policy v1,
/// but without the circuit, the processor allowlist, the age rule or the screen.
contract MockCreditPolicy is ICreditPolicy {
    enum Mode {
        Normal,
        DenyAll,
        RevertCheck,
        AllowEmpty,
        AllowWithReason,
        DenyWithOk
    }

    IRigFeed public immutable feed;
    uint16 public version;
    Mode public mode;

    constructor(IRigFeed feed_, uint16 version_) {
        feed = feed_;
        version = version_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function check(address, uint256[] calldata rigIds, uint8 term, uint256 debt)
        external
        view
        returns (bool allow, uint8 reason, uint16 inputBits, uint256 expected)
    {
        if (mode == Mode.RevertCheck) revert("policy broke");
        if (mode == Mode.AllowEmpty) return (true, Reasons.OK, 0, 0);
        if (!_idsOk(rigIds)) return (false, Reasons.BAD_IDS, 0, 0);
        if (mode == Mode.AllowWithReason) return (true, Reasons.DENIED, 0, 0);
        if (mode == Mode.DenyWithOk) return (false, Reasons.OK, 0, 0);
        bool flags;
        (flags, expected) = _expected(rigIds, term);
        if (!CreditMath.isTerm(term)) return (false, Reasons.DENIED, 0, expected);
        uint8 b = CreditMath.debtBucket(debt, expected);
        inputBits = uint16(term) | (uint16(b) << 2);
        allow = mode == Mode.Normal && flags && b <= CreditMath.bucketLimit(term);
        reason = allow ? Reasons.OK : Reasons.DENIED;
    }

    function maxDebt(address, uint256[] calldata rigIds, uint8 term) external view returns (uint256) {
        if (mode != Mode.Normal || !_idsOk(rigIds) || !CreditMath.isTerm(term)) return 0;
        (bool flags, uint256 expected) = _expected(rigIds, term);
        return flags ? CreditMath.maxDebt(expected, term) : 0;
    }

    function _idsOk(uint256[] calldata ids) internal pure returns (bool) {
        if (ids.length == 0 || ids.length > 16) return false;
        for (uint256 i = 1; i < ids.length; ++i) {
            if (ids[i] <= ids[i - 1]) return false;
        }
        return true;
    }

    function _expected(uint256[] calldata ids, uint8 term) internal view returns (bool flags, uint256 expected) {
        if (!CreditMath.isTerm(term)) return (false, 0);
        flags = true;
        for (uint256 i; i < ids.length; ++i) {
            (RigReport memory r, bool ok) = feed.latest(ids[i]);
            bool fresh = ok && r.rigId == ids[i] && r.observedAt <= block.timestamp + 60
                && block.timestamp <= uint256(r.observedAt) + 300 && r.verifWeight != 0
                && r.verifWeight <= r.totalVerifWeight && r.bonus <= r.verifWeight;
            bool live = r.status == 1 && r.stopBlock == 0 && r.custodied && r.verifWeight > r.bonus;
            if (!fresh || !live) {
                flags = false;
                continue;
            }
            expected += CreditMath.expectedOutput(r.verifWeight - r.bonus, r.totalVerifWeight, term);
        }
    }
}
