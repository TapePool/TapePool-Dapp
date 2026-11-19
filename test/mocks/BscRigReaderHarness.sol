// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BscRigReader} from "../../src/feed/BscRigReader.sol";
import {IRigVaultBsc, IPodMining} from "../../src/interfaces/IBsc.sol";
import {RigReport} from "../../src/interfaces/IRigFeed.sol";

/// Exposes the production reader without changing the reports it returns.
contract BscRigReaderHarness {
    function read(address vault, address pod, uint256 id) external view returns (RigReport memory) {
        return BscRigReader.read(IRigVaultBsc(vault), IPodMining(pod), id);
    }
}

/// Maps a synthetic vault id to a circuit, including miners that have never been bridged.
contract ReaderVault {
    address public circuits;
    uint256 public circuitId;
    address public cell;

    function set(address c, uint256 id, address holder) external {
        circuits = c;
        circuitId = id;
        cell = holder;
    }

    function rigs(uint256) external view returns (address, uint256) {
        return (circuits, circuitId);
    }

    function cellOf(bytes32) external view returns (address) {
        return cell;
    }
}
