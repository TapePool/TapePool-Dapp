// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Interfaces for the live X Layer (chain 196) contracts Tape Pool talks to.
/// RigVoucher ABI is taken from the Sourcify-verified implementation
/// 0x66FB7d52C4931B48776D9019f88F7f58fB0d85E1 (proxy 0x9cfc959cd42B2e1d39a0d850c528210E818AE520).
/// TapeOut factory / circuits / transistors ABIs are derived from bytecode selectors + TAP-02 + Cerebr notes
/// (their sources are NOT verified on Sourcify).

interface IRigVoucher {
    function ownerOf(uint256 id) external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function safeTransferFrom(address from, address to, uint256 id) external;
    function transferFrom(address from, address to, uint256 id) external;
    function approve(address to, uint256 id) external;
    function rigs(uint256 id)
        external
        view
        returns (address circuits, uint64 syncedAt, uint256 circuitId, uint256 power);
    function holderAt(uint256 id, uint256 time) external view returns (address);
    function payeeAt(uint256 id, uint256 time) external view returns (address);
    function marksOf(uint256 id) external view returns (uint256);
    function powerHeld(address) external view returns (uint256);
    function totalPower() external view returns (uint256);
    function redeem(uint256 id, address to) external payable returns (bytes32 guid);
    function quoteRedeem() external view returns (uint256);
    function bem() external view returns (address);
    function oft() external view returns (address);
    function endpoint() external view returns (address);
    function vault() external view returns (address);
    function redeemer(uint256 id) external view returns (address);
    function bonds(uint256 id) external view returns (uint256);
    function lzCompose(address from, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData)
        external
        payable;
}

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILzEndpointV2 {
    function verify(Origin calldata origin, address receiver, bytes32 payloadHash) external;
    function lzReceive(
        Origin calldata origin,
        address receiver,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
    function lzCompose(
        address from,
        address to,
        bytes32 guid,
        uint16 index,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
    function sendCompose(address to, bytes32 guid, uint16 index, bytes calldata message) external;
    function composeQueue(address from, address to, bytes32 guid, uint16 index) external view returns (bytes32);
    function getReceiveLibrary(address receiver, uint32 eid) external view returns (address lib, bool isDefault);
    function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64);
    function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64);
}

interface IOFTLike {
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
    function peers(uint32 eid) external view returns (bytes32);
    function token() external view returns (address);
    function decimals() external view returns (uint8);
    function sharedDecimals() external view returns (uint8);
    function feeBps() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

interface ITapeOutFactory {
    function createCPU(
        string calldata name,
        string calldata symbol,
        string calldata story,
        uint256 transistorSupply,
        uint256 mintPrice
    ) external payable returns (address transistors, address circuits);
    function deployFee() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function cpuCount() external view returns (uint256);
    function cpuAt(uint256 i) external view returns (address);
    function isCPU(address circuits) external view returns (bool);
}

interface ITapeOutTransistors {
    function mint(uint256 id, uint256 amount) external payable;
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function supplyCap() external view returns (uint256);
    function minted() external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function NAND() external view returns (uint256);
    function LATCH() external view returns (uint256);
}

interface ITapeOutCircuits {
    function nextId() external view returns (uint256);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function netlist(uint256 id) external view returns (bytes memory);
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function step(uint256 id, bytes calldata state, bytes calldata inputs)
        external
        view
        returns (bytes memory newState, bytes memory outputs);
    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256 id);
    function TAPEOUT_FEE() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
    function transistors() external view returns (address);
}
