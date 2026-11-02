// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {RigAgent} from "../../src/RigAgent.sol";
import {TapePool} from "../../src/TapePool.sol";

// Hostile test doubles for the reentrancy review (docs/SPEC-PHASE4-REENTRANCY-ROUNDING.md §4.4). A
// hook point (a token transfer, an OKB receive, an ERC-721 receive) calls `Probe.fire`, which records
// the agent and pool views at that point and then makes every armed call, recording how each ended.

/// An actor that can be the pool owner, a borrower or any caller.
contract Probe is IERC721Receiver {
    struct Views {
        bool hasLoan;
        uint256 loanPrincipal;
        uint256 poolLoanPrincipal;
        uint256 collateralLen;
        bool closed;
        uint256 outstanding;
        uint256 idle;
        uint256 totalAssets;
        uint256 totalSupply;
    }

    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    /// How `receive` behaves: fire and accept, burn all gas, or fire and return a large payload.
    enum Receive {
        Fire,
        BurnGas,
        Bomb
    }

    RigAgent public agent;
    TapePool public pool;
    Receive public receiveMode;
    uint256 public bombSize;
    bool public armed;
    uint256 public fired;
    Views internal _seen;
    Call[] internal _calls;
    bool[] internal _oks;
    bytes[] internal _results;

    /// Light mode fits a hook inside `RigAgent.VOUCHER_GAS` (200,000): it reads three views, makes
    /// only the first armed call and writes to slots `primeLight` has already made non-zero.
    bool public light;
    bytes4 public lightSel;
    bool public lightOk;
    bool public lightClosed;
    bool public lightHasLoan;
    uint256 public lightPoolLoan;
    uint256 public lightCollateralLen;

    function watch(RigAgent a, TapePool p) external {
        agent = a;
        pool = p;
    }

    /// Add a call to make at the next hook point. The calls run once, in order.
    function arm(address target, bytes calldata data) external {
        _calls.push(Call(target, data, 0));
        armed = true;
    }

    function armValue(address target, bytes calldata data, uint256 value) external {
        _calls.push(Call(target, data, value));
        armed = true;
    }

    function disarm() external {
        delete _calls;
        armed = false;
    }

    function setReceive(Receive m, uint256 size) external {
        receiveMode = m;
        bombSize = size;
    }

    /// Act as the probe: any call, bubbling its revert.
    function exec(address target, bytes calldata data) external payable returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(r, 0x20), mload(r))
            }
        }
    }

    function primeLight() external {
        light = true;
        lightSel = 0xffffffff;
        lightOk = true;
        lightClosed = true;
        lightHasLoan = true;
        lightPoolLoan = type(uint256).max;
        lightCollateralLen = type(uint256).max;
        fired = 1;
    }

    /// The hook point. Records the views, then makes the armed calls (once).
    function fire() public {
        if (!armed) return;
        armed = false;
        ++fired;
        if (light) {
            lightCollateralLen = agent.collateralOf().length + 1;
            bool c = agent.closed();
            bool h = agent.hasLoan();
            lightPoolLoan = pool.loanPrincipalOf(address(agent)) + 1; // + 1 keeps the slot non-zero
            (bool ok, bytes memory r) = _calls[0].target.call(_calls[0].data);
            bytes4 s;
            if (r.length >= 4) {
                assembly {
                    s := mload(add(r, 0x20))
                }
            }
            (lightSel, lightOk, lightClosed, lightHasLoan) = (s, ok, c, h);
            return;
        }
        _snap();
        uint256 n = _calls.length;
        for (uint256 i; i < n; ++i) {
            Call memory c = _calls[i];
            (bool ok, bytes memory r) = c.target.call{value: c.value}(c.data);
            _oks.push(ok);
            _results.push(r);
        }
    }

    receive() external payable {
        if (receiveMode == Receive.BurnGas) {
            while (true) {}
        }
        fire();
        if (receiveMode == Receive.Bomb) {
            uint256 size = bombSize;
            assembly {
                return(0, size)
            }
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        fire();
        return IERC721Receiver.onERC721Received.selector;
    }

    function seen() external view returns (Views memory) {
        return _seen;
    }

    function resultCount() external view returns (uint256) {
        return _results.length;
    }

    function okAt(uint256 i) external view returns (bool) {
        return _oks[i];
    }

    function resultAt(uint256 i) external view returns (bytes memory) {
        return _results[i];
    }

    function _snap() internal {
        Views memory v;
        if (address(agent) != address(0)) {
            v.hasLoan = agent.hasLoan();
            v.loanPrincipal = agent.loanOf().principal;
            v.collateralLen = agent.collateralOf().length;
            v.closed = agent.closed();
            if (address(pool) != address(0)) v.poolLoanPrincipal = pool.loanPrincipalOf(address(agent));
        }
        if (address(pool) != address(0)) {
            v.outstanding = pool.outstandingPrincipal();
            v.idle = pool.idle();
            v.totalAssets = pool.totalAssets();
            v.totalSupply = pool.totalSupply();
        }
        _seen = v;
    }
}

/// BEM with transfer hooks, like an ERC-777 token: it fires the probe before the balance change when
/// `from` is the trigger address, or after it when `to` is. The live BEM OFT has no such hook (L1).
contract HookBEM is ERC20 {
    enum When {
        Off,
        BeforeFrom,
        AfterTo
    }

    Probe public probe;
    address public trigger;
    When public when;
    uint256 public fires;
    RigAgent public settlementAgent;

    constructor() ERC20("BEM", "BEM") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(Probe p, address trigger_, When w) external {
        probe = p;
        trigger = trigger_;
        when = w;
    }

    function observeSettlement(RigAgent agent) external {
        settlementAgent = agent;
    }

    function _settled() internal view {
        RigAgent agent = settlementAgent;
        if (address(agent) == address(0)) return;
        require(agent.closed() && !agent.hasLoan() && agent.collateralOf().length == 0, "unsettled agent");
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        if (msg.sender == address(settlementAgent)) _settled();
        return super.approve(spender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(settlementAgent) && from != address(0)) _settled();
        if (when == When.BeforeFrom && from == trigger && from != address(0)) {
            ++fires;
            probe.fire();
        }
        super._update(from, to, value);
        if (when == When.AfterTo && to == trigger && to != address(0)) {
            ++fires;
            probe.fire();
        }
    }
}

/// A RIG voucher after a hostile upgrade: transfer hooks, an `ownerOf` that can burn its gas, a large
/// return payload, and a move counter per id. `rigs(id)` answers like the live voucher.
contract HostileVoucher is ERC721 {
    struct Rig {
        address circuits;
        uint64 syncedAt;
        uint256 circuitId;
        uint256 power;
    }

    address public immutable bem;
    mapping(uint256 => Rig) internal _rigs;
    mapping(uint256 => uint256) public moves;
    mapping(uint256 => bool) public blocked;

    Probe public probe;
    /// Fire the probe after a `transferFrom` of this id (0 = any id) from `hookFrom` (0 = anyone).
    uint256 public hookId;
    address public hookFrom;
    bool public hookOn;
    /// `ownerOf(id)` burns gas while the owner is this address (a gas burn after a working transfer):
    /// all of it when `ownerOfBurnGas` is 0, else that much.
    address public burnOwnerOfWhenOwnedBy;
    uint256 public ownerOfBurnGas;
    /// `transferFrom` returns this many bytes after a working transfer.
    uint256 public returnSize;
    bool public burnTransfers;

    constructor(address bem_) ERC721("RIG", "RIG") {
        bem = bem_;
    }

    function mint(address to, uint256 id, uint256 power) external {
        _mint(to, id);
        _rigs[id] = Rig(address(0xC1C), uint64(block.timestamp), id + 1000, power);
    }

    function setRig(uint256 id, uint64 syncedAt, uint256 power) external {
        _rigs[id].syncedAt = syncedAt;
        _rigs[id].power = power;
    }

    function setHook(Probe p, uint256 id, address from) external {
        probe = p;
        hookId = id;
        hookFrom = from;
        hookOn = true;
    }

    function clearHook() external {
        hookOn = false;
    }

    function setBlocked(uint256 id, bool b) external {
        blocked[id] = b;
    }

    function setBurnOwnerOf(address whenOwnedBy) external {
        burnOwnerOfWhenOwnedBy = whenOwnedBy;
    }

    function setOwnerOfBurnGas(uint256 g) external {
        ownerOfBurnGas = g;
    }

    function setReturnSize(uint256 n) external {
        returnSize = n;
    }

    function setBurnTransfers(bool value) external {
        burnTransfers = value;
    }

    function rigs(uint256 id) external view returns (address, uint64, uint256, uint256) {
        Rig memory r = _rigs[id];
        return (r.circuits, r.syncedAt, r.circuitId, r.power);
    }

    /// The owner without the gas burn, for test assertions.
    function ownerUnsafe(uint256 id) external view returns (address) {
        return _ownerOf(id);
    }

    function ownerOf(uint256 id) public view override returns (address o) {
        o = super.ownerOf(id);
        if (o == burnOwnerOfWhenOwnedBy && o != address(0)) {
            uint256 n = ownerOfBurnGas;
            if (n == 0) {
                while (true) {}
            }
            uint256 start = gasleft();
            while (start - gasleft() < n) {}
        }
    }

    function transferFrom(address from, address to, uint256 id) public override {
        if (burnTransfers) while (true) {}
        if (blocked[id]) revert("blocked");
        super.transferFrom(from, to, id);
        ++moves[id];
        if (hookOn && (hookId == 0 || hookId == id) && (hookFrom == address(0) || hookFrom == from)) {
            probe.fire();
        }
        uint256 n = returnSize;
        if (n != 0) {
            assembly {
                return(0, n)
            }
        }
    }
}
