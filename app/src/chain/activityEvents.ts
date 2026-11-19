import type { AbiEvent } from 'viem';

export const activityEvents = [
  { type: 'event', name: 'Deposit', inputs: [
    { type: 'address', name: 'sender', indexed: true },
    { type: 'address', name: 'owner', indexed: true },
    { type: 'uint256', name: 'assets' },
    { type: 'uint256', name: 'shares' },
  ] },
  { type: 'event', name: 'Withdraw', inputs: [
    { type: 'address', name: 'sender', indexed: true },
    { type: 'address', name: 'receiver', indexed: true },
    { type: 'address', name: 'owner', indexed: true },
    { type: 'uint256', name: 'assets' },
    { type: 'uint256', name: 'shares' },
  ] },
  { type: 'event', name: 'Lent', inputs: [
    { type: 'address', name: 'agent', indexed: true },
    { type: 'address', name: 'borrower', indexed: true },
    { type: 'uint256', name: 'amount' },
  ] },
  { type: 'event', name: 'RepaymentReceived', inputs: [
    { type: 'address', name: 'agent', indexed: true },
    { type: 'uint256', name: 'fee' },
    { type: 'uint256', name: 'toReserve' },
    { type: 'uint256', name: 'principal' },
  ] },
] as const satisfies readonly AbiEvent[];
