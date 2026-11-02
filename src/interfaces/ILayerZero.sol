// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Origin} from "./IXLayer.sol";

/// Minimal LayerZero EndpointV2 surface used by the rig data feed (sender on BSC, receiver on X Layer).
/// Same endpoint address on BSC and X Layer: 0x1a44076050125825900e736c501f859c50fE728c.

struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    bytes options;
    bool payInLzToken;
}

struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

struct MessagingReceipt {
    bytes32 guid;
    uint64 nonce;
    MessagingFee fee;
}

struct SetConfigParam {
    uint32 eid;
    uint32 configType;
    bytes config;
}

struct UlnConfig {
    uint64 confirmations;
    uint8 requiredDVNCount;
    uint8 optionalDVNCount;
    uint8 optionalDVNThreshold;
    address[] requiredDVNs;
    address[] optionalDVNs;
}

interface ILzEndpointSend {
    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);
    function quote(MessagingParams calldata params, address sender) external view returns (MessagingFee memory);
    function setDelegate(address delegate) external;
    function delegates(address oapp) external view returns (address);
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
    function setSendLibrary(address oapp, uint32 eid, address newLib) external;
    function setReceiveLibrary(address oapp, uint32 eid, address newLib, uint256 gracePeriod) external;
    function getSendLibrary(address sender, uint32 dstEid) external view returns (address);
    function getReceiveLibrary(address receiver, uint32 srcEid) external view returns (address lib, bool isDefault);
    function verify(Origin calldata origin, address receiver, bytes32 payloadHash) external;
    function lzReceive(
        Origin calldata origin,
        address receiver,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
}

/// @notice Read side of a LayerZero ULN 302 message library. `getUlnConfig` is the effective config
///         (the app's own values with DEFAULT fields filled from the library default);
///         `getAppUlnConfig` is the app's raw stored config.
interface IUlnConfigReader {
    function getUlnConfig(address oapp, uint32 remoteEid) external view returns (UlnConfig memory);
    function getAppUlnConfig(address oapp, uint32 remoteEid) external view returns (UlnConfig memory);
}

interface ILzReceiver {
    function allowInitializePath(Origin calldata origin) external view returns (bool);
    function nextNonce(uint32 eid, bytes32 sender) external view returns (uint64);
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}
