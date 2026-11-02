#!/usr/bin/env bash
# RD3-06 gate (SPEC-REDEPLOY-3), chunked: the public X Layer RPC drops long eth_getLogs runs, so scan the 2026-10-31 factory's
# AgentCreated logs in 10,000-block chunks (each retried), check every agent found, then run the gate's own
# `check` from the scan's end block to the head (pool checks plus the last pages). Read-only.
# Usage: bash script/deploy/check-old-stack-chunked.sh   (needs forge and cast; X Layer public RPC)
set -uo pipefail
cd "$(dirname "$0")/../.."
R=https://rpc.xlayer.tech
POOL=0xFD48226e11FCFF465033305574D87bCE004314BA
FACTORY=0x123B9EAaAeae5047a9E5c96e3b9C81177d57607c
BEM=0x60e62Efa9405d6873C5deaBD4E6CC91c25363952
FROM=74685770
STEP=10000
TO=$(cast block-number --rpc-url $R)
S=script/deploy/CheckOldStack.s.sol
fs() { forge script $S --offline --rpc-url xlayer "$@" 2>&1 | grep -v "clone\|submodule\|missing dependencies\|already exists"; }

echo "scan $FROM..$TO in chunks of $STEP"
found=""
for ((s = FROM; s <= TO; s += STEP)); do
  e=$((s + STEP - 1)); [ $e -gt $TO ] && e=$TO
  ok=""
  for a in 1 2 3 4 5; do
    out=$(fs --sig "scanAgents(address,uint256,uint256)" $FACTORY $s $e)
    if echo "$out" | grep -q "Script ran successfully"; then
      agents=$(echo "$out" | sed -n '/== Return ==/,$p' | grep -o "0x[0-9a-fA-F]\{40\}" | sort -u | tr '\n' ' ')
      echo "$s-$e ok (attempt $a) agents: ${agents:-none}"
      found="$found $agents"; ok=1; break
    fi
    sleep 5
  done
  [ -z "$ok" ] && { echo "$s-$e FAILED after 5 attempts"; echo "$out" | grep -E "Error" | sed -E 's#https?://[^ )"]+#<rpc>#g' | tail -2; exit 1; }
done

for agent in $found; do
  out=$(fs --sig "checkAgent(address,address)" $agent $BEM)
  echo "$out" | grep -E "old agent|BEM|vouchers held|Error|revert"
  echo "$out" | grep -q "Script ran successfully" || { echo "AGENT CHECK FAILED $agent"; exit 1; }
done

out=$(fs --sig "check(address,address,uint256)" $POOL $FACTORY $TO)
echo "$out" | grep -E "old agents found|old agent|BEM|vouchers held|PASS|Error|revert" | sed -E 's#https?://[^ )"]+#<rpc>#g'
echo "$out" | grep -q "PASS: old stack may be retired" && echo "RD3-06 GATE PASS (chunked scan $FROM..$TO, then check from $TO)" || echo "RD3-06 GATE FAILED"
