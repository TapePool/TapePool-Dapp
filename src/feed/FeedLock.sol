// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUlnConfigReader, UlnConfig} from "../interfaces/ILayerZero.sol";

/// @notice DVN-config checks both feed contracts run inside `lock` (SPEC-PHASE3 §5.5 step 4).
library FeedLock {
    /// @dev The ULN's "use the library default" sentinel for counts and confirmations.
    uint8 internal constant DEFAULT = 0;

    error ConfigMismatch();
    error ConfigNotExplicit();

    /// @notice Revert unless `oapp`'s effective config on `lib` for `eid` equals the BEM bridge's
    ///         (`bemRef`) field by field, and `oapp`'s own stored config has no DEFAULT field, so a
    ///         later change of LayerZero's defaults cannot alter it.
    function requireMirrored(address lib, address oapp, address bemRef, uint32 eid) internal view {
        IUlnConfigReader uln = IUlnConfigReader(lib);
        UlnConfig memory ours = uln.getUlnConfig(oapp, eid);
        UlnConfig memory theirs = uln.getUlnConfig(bemRef, eid);
        if (keccak256(abi.encode(ours)) != keccak256(abi.encode(theirs))) revert ConfigMismatch();
        UlnConfig memory app = uln.getAppUlnConfig(oapp, eid);
        if (app.confirmations == DEFAULT || app.requiredDVNCount == DEFAULT || app.optionalDVNCount == DEFAULT) {
            revert ConfigNotExplicit();
        }
    }
}
