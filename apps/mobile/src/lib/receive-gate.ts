import {
  RECEIVE_GATE_CHECKING_COPY,
  RECEIVE_GATE_OFFLINE_COPY,
  RECEIVE_GATE_UNKNOWN_COPY,
  RECEIVE_MANAGER_POSTS_COPY,
  receivingGate,
  ROLES,
  type ReceivingGate,
  type Role,
} from '@stockpilot/core';

import { api } from './api';

/**
 * WHO MAY POST A RECEIPT AND RECORD ITS CHECKLIST, ON THE PHONE (F4-1).
 *
 * The PO screen showed Post receipt, Scan and the quantity fields to everyone
 * who could open the purchase order. ledger.post_receipt_v2 is manager-only,
 * so staff and viewers typed the quantities and were refused only when they
 * posted. The screen now asks core receivingGate, the ONE predicate the web
 * page, ReceivingService.postReceipt and the checklist service use (F1-2's
 * count-close-gate.ts shape):
 *
 *   - the role and the effective permissions come together from
 *     GET /api/v1/me/permissions (the same request context the post itself
 *     runs under), read when the screen opens online, and are remembered in
 *     memory for this account and workspace, so reopening a PO offline in the
 *     same session still knows;
 *   - whether Receiving is on comes from the enabled modules
 *     (useEnabledModules), applied when the gate is used, so a module change
 *     never needs a second request;
 *   - before any answer the footer says so; it never guesses in either
 *     direction, and the quantities stay read only until a known yes.
 *
 * Pure apart from fetchReceiveFacts, so it runs under the node tests.
 */

/** What /api/v1/me/permissions says about this person, for the gate. */
export interface ReceiveGateFacts {
  role: Role;
  canAdjust: boolean;
  canReadPo: boolean;
  canManagePo: boolean;
}

/** Thrown when /api/v1/me/permissions does not answer in the expected shape. */
export class ReceiveGateResponseError extends Error {
  constructor() {
    super('The server sent an unexpected answer.');
    this.name = 'ReceiveGateResponseError';
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** The facts from /api/v1/me/permissions' `{ role, permissions }` (closeGateFromMe's shape). */
export function receiveFactsFromMe(res: unknown): ReceiveGateFacts {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new ReceiveGateResponseError();
  }
  const r = res as { role?: unknown; permissions?: unknown };
  if (!isRole(r.role) || !Array.isArray(r.permissions)) throw new ReceiveGateResponseError();
  const perms = new Set(r.permissions.filter((p): p is string => typeof p === 'string'));
  return {
    role: r.role,
    canAdjust: perms.has('stock:adjust'),
    canReadPo: perms.has('purchase_orders:read'),
    canManagePo: perms.has('purchase_orders:manage'),
  };
}

/** core receivingGate for these facts, with Receiving on or off now. */
export function receiveGateFromFacts(facts: ReceiveGateFacts, receivingOn: boolean): ReceivingGate {
  return receivingGate({ ...facts, receivingOn });
}

const remembered = new Map<string, ReceiveGateFacts>();
const keyOf = (userId: string, orgId: string) => `${userId}\u0000${orgId}`;

/** The last answer for this account and workspace in this app session. */
export function rememberedReceiveFacts(
  userId: string | null | undefined,
  orgId: string | null | undefined,
): ReceiveGateFacts | null {
  if (!userId || !orgId) return null;
  return remembered.get(keyOf(userId, orgId)) ?? null;
}

/** Ask the server, remember the answer, return it. Throws on any failure. */
export async function fetchReceiveFacts(userId: string, orgId: string): Promise<ReceiveGateFacts> {
  const facts = receiveFactsFromMe(await api<unknown>('/api/v1/me/permissions'));
  remembered.set(keyOf(userId, orgId), facts);
  return facts;
}

/** Test seam (and sign-out): forget every remembered answer. */
export function forgetReceiveGates(): void {
  remembered.clear();
}

/** What the screen knows about the gate right now. */
export type ReceiveGateState =
  | { kind: 'known'; facts: ReceiveGateFacts }
  | { kind: 'loading' }
  | { kind: 'unknown'; offline: boolean };

/** The account and workspace an answer belongs to; null before both are known. */
export function receiveGateKey(
  userId: string | null | undefined,
  orgId: string | null | undefined,
): string | null {
  return userId && orgId ? keyOf(userId, orgId) : null;
}

/** The screen's last answer from the server, for the key it was asked under. */
export type ReceiveGateAnswer =
  { key: string; facts: ReceiveGateFacts } | { key: string; failed: true };

/**
 * What the screen shows. An answer counts only for the account and workspace
 * it was asked under (a switch never carries one over); a failed check falls
 * back to the answer remembered this session; with nothing known it is
 * "checking" online and the offline line offline (posting needs a connection
 * anyway), never "checking" for an answer that cannot come.
 */
export function receiveGateState(input: {
  answer: ReceiveGateAnswer | null;
  key: string | null;
  remembered: ReceiveGateFacts | null;
  offline: boolean;
}): ReceiveGateState {
  const { answer, key, remembered, offline } = input;
  if (key !== null && answer !== null && answer.key === key && 'facts' in answer) {
    return { kind: 'known', facts: answer.facts };
  }
  if (remembered) return { kind: 'known', facts: remembered };
  if (offline) return { kind: 'unknown', offline: true };
  if (key !== null && answer !== null && answer.key === key) {
    return { kind: 'unknown', offline: false };
  }
  return { kind: 'loading' };
}

/** The gate when it is known; null while it is not (never a guess). */
export function receiveGateOf(state: ReceiveGateState, receivingOn: boolean): ReceivingGate | null {
  return state.kind === 'known' ? receiveGateFromFacts(state.facts, receivingOn) : null;
}

/**
 * Whether the quantity fields, their All buttons, the size runs and Scan take
 * input: never on a draft (F2-5's review mode), and otherwise only on a known
 * yes from the gate. One rule for all three entry paths, so they cannot drift.
 */
export function canEditReceiptQuantities(input: {
  reviewOnly: boolean;
  gate: ReceiveGateState;
}): boolean {
  if (input.reviewOnly || input.gate.kind !== 'known') return false;
  return receiveGateFromFacts(input.gate.facts, false).canPostReceipt;
}

/** What the PO screen's pinned footer shows. */
export type ReceiveFooter =
  | { kind: 'none' }
  | { kind: 'post'; label: string; disabled: boolean }
  | { kind: 'manager_posts'; text: string }
  | { kind: 'checking'; text: string }
  | { kind: 'unknown'; text: string; retry: boolean };

/**
 * The footer. A draft shows none (and the screen makes no gate request for
 * one). Post receipt appears ONLY on a known yes; stock:adjust alone is never
 * enough (staff hold it by default).
 */
export function receiveFooter(input: {
  reviewOnly: boolean;
  gate: ReceiveGateState;
  posting: boolean;
  anyReceivable: boolean;
}): ReceiveFooter {
  if (input.reviewOnly) return { kind: 'none' };
  const { gate } = input;
  if (gate.kind === 'loading') return { kind: 'checking', text: RECEIVE_GATE_CHECKING_COPY };
  if (gate.kind === 'unknown') {
    return gate.offline
      ? { kind: 'unknown', text: RECEIVE_GATE_OFFLINE_COPY, retry: false }
      : { kind: 'unknown', text: RECEIVE_GATE_UNKNOWN_COPY, retry: true };
  }
  if (!receiveGateFromFacts(gate.facts, false).canPostReceipt) {
    return { kind: 'manager_posts', text: RECEIVE_MANAGER_POSTS_COPY };
  }
  return {
    kind: 'post',
    label: input.posting ? 'Posting…' : input.anyReceivable ? 'Post receipt' : 'Fully received',
    disabled: input.posting || !input.anyReceivable,
  };
}
