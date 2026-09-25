import {
  CYCLE_COUNT_MANAGER_POSTS_COPY,
  cycleCountCloseGate,
  ROLES,
  type Role,
} from '@stockpilot/core';

import { api } from './api';

/**
 * WHO MAY POST A COUNT, ON THE PHONE (F1-2's Post fix).
 *
 * The count screen used to show its Post footer to anyone who could count
 * (stock:adjust, and the assignee). ledger.post_cycle_count is manager-only,
 * so staff tapped Post and got a refusal. The screen now asks core
 * cycleCountCloseGate, the ONE predicate the web page and the service use:
 * manager or above with stock:adjust.
 *
 * The role and the effective permissions come together from
 * GET /api/v1/me/permissions (the same request context the post itself will
 * run under), read when the screen opens online. The answer is remembered in
 * memory for this account and workspace, so reopening a count offline in the
 * same session still knows. Before any answer the footer says so; it never
 * guesses in either direction:
 *   - a known "no" shows "A manager reviews and posts this count.";
 *   - offline with nothing known: posting needs a connection anyway, and the
 *     footer says who posts;
 *   - a failed check offers to check again.
 * Pure apart from fetchCountCloseGate, so it runs under the node tests.
 */

export interface CountCloseGate {
  canPost: boolean;
  canCancel: boolean;
}

/** Thrown when /api/v1/me/permissions does not answer in the expected shape. */
export class CloseGateResponseError extends Error {
  constructor() {
    super('The server sent an unexpected answer.');
    this.name = 'CloseGateResponseError';
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** The gate from /api/v1/me/permissions' `{ role, permissions }`. */
export function closeGateFromMe(res: unknown): CountCloseGate {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) throw new CloseGateResponseError();
  const r = res as { role?: unknown; permissions?: unknown };
  if (!isRole(r.role) || !Array.isArray(r.permissions)) throw new CloseGateResponseError();
  const perms = new Set(r.permissions.filter((p): p is string => typeof p === 'string'));
  return cycleCountCloseGate({
    role: r.role,
    canAdjust: perms.has('stock:adjust'),
    canAssign: perms.has('cycle_counts:assign'),
  });
}

const remembered = new Map<string, CountCloseGate>();
const keyOf = (userId: string, orgId: string) => `${userId}\u0000${orgId}`;

/** The last answer for this account and workspace in this app session. */
export function rememberedCloseGate(userId: string | null | undefined, orgId: string | null | undefined): CountCloseGate | null {
  if (!userId || !orgId) return null;
  return remembered.get(keyOf(userId, orgId)) ?? null;
}

/** Ask the server, remember the answer, return it. Throws on any failure. */
export async function fetchCountCloseGate(userId: string, orgId: string): Promise<CountCloseGate> {
  const gate = closeGateFromMe(await api<unknown>('/api/v1/me/permissions'));
  remembered.set(keyOf(userId, orgId), gate);
  return gate;
}

/** Test seam (and sign-out): forget every remembered answer. */
export function forgetCloseGates(): void {
  remembered.clear();
}

/** What the screen knows about the gate right now. */
export type CloseGateState =
  | { kind: 'known'; gate: CountCloseGate }
  | { kind: 'loading' }
  | { kind: 'unknown'; offline: boolean };

/** What the count screen's pinned footer shows. */
export type CountFooter =
  | { kind: 'post'; label: string; disabled: boolean; partial: boolean }
  | { kind: 'manager_posts'; text: string }
  | { kind: 'checking'; text: string }
  | { kind: 'unknown'; text: string; retry: boolean };

export const COUNT_POST_CHECKING_COPY = 'Checking who can post this count...';
export const COUNT_POST_UNKNOWN_OFFLINE_COPY = `Posting needs a connection. ${CYCLE_COUNT_MANAGER_POSTS_COPY}`;
export const COUNT_POST_UNKNOWN_COPY = 'Could not check who can post this count.';

/**
 * The footer for someone who can count this open count. Post appears ONLY on
 * a known yes from the gate; stock:adjust (being able to count) is never
 * enough on its own.
 */
export function countFooter(input: {
  gate: CloseGateState;
  posting: boolean;
  offline: boolean;
  hasPending: boolean;
  countedCount: number;
  total: number;
}): CountFooter {
  const { gate } = input;
  if (gate.kind === 'loading') return { kind: 'checking', text: COUNT_POST_CHECKING_COPY };
  if (gate.kind === 'unknown') {
    return gate.offline
      ? { kind: 'unknown', text: COUNT_POST_UNKNOWN_OFFLINE_COPY, retry: false }
      : { kind: 'unknown', text: COUNT_POST_UNKNOWN_COPY, retry: true };
  }
  if (!gate.gate.canPost) return { kind: 'manager_posts', text: CYCLE_COUNT_MANAGER_POSTS_COPY };
  const allCounted = input.total > 0 && input.countedCount === input.total;
  const label = input.posting
    ? 'Posting…'
    : input.offline
      ? 'Reconnect to post'
      : input.hasPending
        ? 'Sync pending edits to post'
        : allCounted
          ? 'Post cycle count'
          : `Post (${input.countedCount}/${input.total} counted)`;
  return {
    kind: 'post',
    label,
    disabled: input.posting || input.countedCount === 0 || input.offline || input.hasPending,
    partial: !allCounted,
  };
}
