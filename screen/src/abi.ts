// ABIs of the contracts the screen reads. PodMining is not verified: its layout comes from the TapeOut
// client ABI and was checked against live reads (SPEC-PHASE3-SCREEN S2, S10).
import { parseAbi } from "viem";

export const podAbi = parseAbi([
  "struct Task { uint8 kind; uint32 cycles; uint32 nIn; uint32 nOut; uint32 vectorCount; bool active; bytes32 vectorsRoot; string name; uint64 refArea; uint256 refCost; address refCircuits; uint64 refCircuitId; }",
  "struct Miner { address circuits; uint64 circuitId; uint32 taskId; uint32 gateCount; uint32 stateCount; uint32 depth; uint64 area; uint32 mult; uint64 since; uint8 status; address registrant; uint32 nandBurn; uint32 latchBurn; uint64 bstar; uint64 bonus; bool optimal; uint64 commitBlock; uint64 firstUnusedId; uint64 stopBlock; uint128 verifWeight; uint128 unverWeight; uint256 debt; }",
  "function getTask(uint32 taskId) view returns (Task)",
  "function getMiner(bytes32 key) view returns (Miner)",
  "function minerKey(address circuits, uint256 circuitId) pure returns (bytes32)",
  "function isSealed() view returns (bool)",
  "function owner() view returns (address)",
  "function tasksFrozen() view returns (bool)",
  "function paused() view returns (bool)",
  "function maxRunGas() view returns (uint256)",
  "function MAX_REF_LEVELS() view returns (uint256)",
  "function ceCount(uint32 taskId, address circuits) view returns (uint256)",
  "function passesCounterexamples(address circuits, uint256 circuitId, uint32 taskId, uint32 gateCount, uint256 budget) view returns (bool)",
  "function challenge(bytes32 key, uint32 vectorIndex, bytes input, bytes expectedOut, bytes32[] proof)",
]);

export const cpuAbi = parseAbi([
  "function netlist(uint256 id) view returns (bytes)",
  "function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)",
  "function eval(uint256 id, bytes inputs) view returns (bytes)",
  "function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)",
]);

export const beaconAbi = parseAbi(["function implementation() view returns (address)"]);

export const vaultAbi = parseAbi(["function rigs(uint256 id) view returns (address circuits, uint256 circuitId)"]);

export const voucherAbi = parseAbi([
  "function rigs(uint256 id) view returns (address circuits, uint64 syncedAt, uint256 circuitId, uint256 power)",
]);

export const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export const rigScreenAbi = parseAbi([
  "function recordPass(uint256 rigId, address circuits, uint64 circuitId, uint32 taskId, bytes32 artifactHash)",
]);
