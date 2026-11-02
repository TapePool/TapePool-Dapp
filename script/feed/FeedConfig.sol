// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILzEndpointSend, IUlnConfigReader, SetConfigParam, UlnConfig} from "../../src/interfaces/ILayerZero.sol";

/// The feed session's DVN-config step (SPEC-PHASE3 §5.5 step 4, §5.6): copy the BEM bridge's
/// effective ULN config and write every zero field as the NIL sentinel, so our app config has no
/// DEFAULT field and its effective value still equals the bridge's.
library FeedConfig {
    uint32 internal constant ULN_CONFIG = 2;

    function nil(UlnConfig memory c) internal pure returns (UlnConfig memory) {
        if (c.confirmations == 0) c.confirmations = type(uint64).max;
        if (c.requiredDVNCount == 0) c.requiredDVNCount = type(uint8).max;
        if (c.optionalDVNCount == 0) c.optionalDVNCount = type(uint8).max;
        return c;
    }

    /// @notice Mirror `bemRef`'s effective config on `lib` for `eid` onto `oapp`. The caller must be
    ///         `oapp`'s delegate.
    function mirror(ILzEndpointSend ep, address oapp, address lib, uint32 eid, address bemRef) internal {
        UlnConfig memory c = nil(IUlnConfigReader(lib).getUlnConfig(bemRef, eid));
        SetConfigParam[] memory ps = new SetConfigParam[](1);
        ps[0] = SetConfigParam(eid, ULN_CONFIG, abi.encode(c));
        ep.setConfig(oapp, lib, ps);
    }
}
