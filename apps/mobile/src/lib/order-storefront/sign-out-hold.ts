import {
  SIGN_OUT_WITHDRAW_UNANSWERED_COPY,
  classifyOrderSettleResult,
  formatOrderNumber,
  orderAlreadyPlacedCopy,
  orderCallResultForOrganization,
  type OrderCallResult,
  type PendingOrderSubmission,
} from '@stockpilot/core';

import { ORDER_DRAFT_PREFIX, unsettledSubmissions } from './store';

/**
 * SIGNING OUT WITH AN ORDER REQUEST THAT ISN'T CONFIRMED (phone ordering PO-4,
 * plan 3.6). Signing out removes every `workspace.` key, the cart and its
 * pending send with them. The send's KEY is what can still settle it, so the
 * sign-out flow (sign-out-flow.ts) first reads each one's status (a read,
 * never a send), and if one is still unknown asks:
 *   - Stay signed in;
 *   - Don't send it and sign out: withdraw first (the answer is final:
 *     withdrawn, or "It had already been placed: SO-…");
 *   - Sign out: write the HOLD MARKER below.
 *
 * THE MARKER holds no personal data: `{ orgId, warehouseId, key, sentAt,
 * lineCount, unitCount }`, no names, emails, notes or item ids (the body
 * went with the account). It is kept OUTSIDE the `workspace.` prefix
 * (`orderSubmissionHold.v1.<user>`), so the sign-out does not remove it, the
 * way the outbox holds an account's rows across a sign-out
 * (sign-out-flow.ts). At the same account's next sign-in it is read: placed
 * says "Your order request SO-… was placed."; refused or withdrawn clears it;
 * still unknown offers "Don't send it" and "See my orders". Nothing is ever
 * resent. Pure, apart from the injected calls.
 */

export const ORDER_HOLD_PREFIX = 'orderSubmissionHold.v1.';

export function orderHoldKey(userId: string): string {
  return `${ORDER_HOLD_PREFIX}${userId}`;
}

export interface OrderSubmissionHold {
  orgId: string;
  warehouseId: string;
  key: string;
  sentAt: string;
  lineCount: number;
  unitCount: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The marker for one unsettled send: ids, a time and two counts only. */
export function holdFor(input: { orgId: string; warehouseId: string; pending: PendingOrderSubmission }): OrderSubmissionHold {
  const lines = Array.isArray(input.pending.body.lines) ? (input.pending.body.lines as unknown[]) : [];
  let units = 0;
  for (const l of lines) {
    const q = typeof l === 'object' && l !== null ? (l as { quantity?: unknown }).quantity : null;
    if (typeof q === 'number' && Number.isFinite(q)) units += q;
  }
  return {
    orgId: input.orgId,
    warehouseId: input.warehouseId,
    key: input.pending.key,
    sentAt: input.pending.firstSentAt,
    lineCount: lines.length,
    unitCount: units,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads the stored markers; anything that is not exactly a marker is
 *  dropped (and no other field is ever kept). */
export function parseHolds(raw: string | null): OrderSubmissionHold[] {
  if (raw === null) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(v) || v.v !== 1 || !Array.isArray(v.holds)) return [];
  const out: OrderSubmissionHold[] = [];
  for (const h of v.holds) {
    if (!isRecord(h)) continue;
    const { orgId, warehouseId, key, sentAt, lineCount, unitCount } = h;
    if (typeof orgId !== 'string' || typeof warehouseId !== 'string') continue;
    if (typeof key !== 'string' || !UUID.test(key) || typeof sentAt !== 'string') continue;
    if (typeof lineCount !== 'number' || typeof unitCount !== 'number') continue;
    if (out.some((x) => x.key === key && x.orgId === orgId)) continue;
    out.push({ orgId, warehouseId, key, sentAt, lineCount, unitCount });
  }
  return out;
}

/** Writes the markers (null: remove the key). Each is rebuilt field by field,
 *  so nothing else can ride along. */
export function serializeHolds(holds: readonly OrderSubmissionHold[]): string | null {
  if (holds.length === 0) return null;
  return JSON.stringify({
    v: 1,
    holds: holds.map((h) => ({
      orgId: h.orgId,
      warehouseId: h.warehouseId,
      key: h.key,
      sentAt: h.sentAt,
      lineCount: h.lineCount,
      unitCount: h.unitCount,
    })),
  });
}

/** Adds markers, one per (organization, key). */
export function mergeHolds(
  existing: readonly OrderSubmissionHold[],
  added: readonly OrderSubmissionHold[],
): OrderSubmissionHold[] {
  const out = [...existing];
  for (const h of added) if (!out.some((x) => x.key === h.key && x.orgId === h.orgId)) out.push(h);
  return out;
}

/** What a status read (or a withdraw) of a held key said. */
export type HoldCheck =
  | { outcome: 'placed'; label: string | null }
  | { outcome: 'settled' }
  | { outcome: 'unknown' };

/** Read through core: placed names its order, refused and withdrawn clear
 *  the marker silently, anything else (none, no answer, a refusal of the
 *  read itself) keeps it. An answer for another organization is no answer. */
export function holdCheckFrom(result: OrderCallResult, orgId: string): HoldCheck {
  const outcome = classifyOrderSettleResult(orderCallResultForOrganization(result, orgId));
  if (!outcome.final) return { outcome: 'unknown' };
  if (outcome.outcome === 'placed') {
    return { outcome: 'placed', label: outcome.order.orderLabel ?? formatOrderNumber(outcome.order.orderNumber) };
  }
  return { outcome: 'settled' };
}

// ── The sign-out's half (sign-out-flow.ts SignOutOrderSubmissions) ──────────

/** The storage these read and write (AsyncStorage in the app). */
export interface HoldStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
}

export interface HoldCalls {
  status(scope: { orgId: string; userId: string }, key: string): Promise<OrderCallResult>;
  withdraw(scope: { orgId: string; userId: string }, key: string): Promise<OrderCallResult>;
}

async function deviceSends(store: HoldStore, userId: string) {
  const prefix = `${ORDER_DRAFT_PREFIX}${userId}.`;
  const keys = (await store.getAllKeys()).filter((k) => k.startsWith(prefix));
  const entries = keys.length > 0 ? await store.multiGet(keys) : [];
  return unsettledSubmissions(entries, userId, null);
}

/**
 * The sign-out flow's order-request steps for one account. Reads only (status)
 * unless the person chose "Don't send it" (withdraw). A key found settled
 * during this sign-out is not counted again; the drafts themselves go with
 * the account's storage once the session ends.
 */
export function createSignOutOrderSubmissions(deps: {
  userId: string;
  store: HoldStore;
  calls: HoldCalls;
  /** Tell the person (an alert in the app). */
  say(message: string): Promise<void>;
}) {
  const settled = new Set<string>();
  const live = async () =>
    (await deviceSends(deps.store, deps.userId)).filter((s) => !settled.has(`${s.orgId}.${s.pending.key}`));
  const scopeOf = (orgId: string) => ({ orgId, userId: deps.userId });
  return {
    async count() {
      return (await live()).length;
    },
    async settle() {
      for (const s of await live()) {
        const check = holdCheckFrom(await deps.calls.status(scopeOf(s.orgId), s.pending.key), s.orgId);
        if (check.outcome !== 'unknown') settled.add(`${s.orgId}.${s.pending.key}`);
      }
    },
    async withdraw() {
      const placed: string[] = [];
      for (const s of await live()) {
        const check = holdCheckFrom(await deps.calls.withdraw(scopeOf(s.orgId), s.pending.key), s.orgId);
        if (check.outcome === 'unknown') continue;
        settled.add(`${s.orgId}.${s.pending.key}`);
        if (check.outcome === 'placed') placed.push(check.label ?? '');
      }
      return { placed };
    },
    async hold() {
      const adds = (await live()).map((s) => holdFor(s));
      if (adds.length === 0) return;
      const key = orderHoldKey(deps.userId);
      const merged = mergeHolds(parseHolds(await deps.store.getItem(key)), adds);
      const raw = serializeHolds(merged);
      if (raw !== null) await deps.store.setItem(key, raw);
    },
    async report(result: { placed: string[]; unanswered: number }) {
      const lines = result.placed.map((label) =>
        orderAlreadyPlacedCopy({ orderNumber: null, orderLabel: label === '' ? null : label }),
      );
      if (result.unanswered > 0) lines.push(SIGN_OUT_WITHDRAW_UNANSWERED_COPY);
      if (lines.length > 0) await deps.say(lines.join(' '));
    },
  };
}

// ── The next sign-in's half ─────────────────────────────────────────────────

export interface HeldCheckResult {
  /** Orders the held keys turned out to have placed ("SO-000123", or null). */
  placed: (string | null)[];
  /** Still not known: offer "Don't send it" and "See my orders". */
  unknown: OrderSubmissionHold[];
}

/**
 * At sign-in (and on foreground while any are held): read each held key's
 * status. Placed is said, refused and withdrawn clear the marker, anything
 * else keeps it. A key still live in this device's drafts (a sign-out that
 * did not end the session) is left to the storefront. Never sends.
 */
export async function checkHeldSubmissions(deps: {
  userId: string;
  store: HoldStore;
  calls: HoldCalls;
}): Promise<HeldCheckResult> {
  const key = orderHoldKey(deps.userId);
  const holds = parseHolds(await deps.store.getItem(key));
  if (holds.length === 0) return { placed: [], unknown: [] };
  const onDevice = new Set((await deviceSends(deps.store, deps.userId)).map((s) => `${s.orgId}.${s.pending.key}`));
  const kept: OrderSubmissionHold[] = [];
  const placed: (string | null)[] = [];
  const unknown: OrderSubmissionHold[] = [];
  for (const h of holds) {
    if (onDevice.has(`${h.orgId}.${h.key}`)) {
      kept.push(h);
      continue;
    }
    const check = holdCheckFrom(await deps.calls.status({ orgId: h.orgId, userId: deps.userId }, h.key), h.orgId);
    if (check.outcome === 'placed') placed.push(check.label);
    else if (check.outcome === 'unknown') {
      kept.push(h);
      unknown.push(h);
    }
  }
  const raw = serializeHolds(kept);
  if (raw === null) await deps.store.removeItem(key);
  else if (kept.length !== holds.length) await deps.store.setItem(key, raw);
  return { placed, unknown };
}

/** "Don't send it" for a held key: withdraw it (its answer is final). */
export async function withdrawHeldSubmission(
  deps: { userId: string; store: HoldStore; calls: HoldCalls },
  hold: OrderSubmissionHold,
): Promise<HoldCheck> {
  const check = holdCheckFrom(await deps.calls.withdraw({ orgId: hold.orgId, userId: deps.userId }, hold.key), hold.orgId);
  if (check.outcome !== 'unknown') {
    const key = orderHoldKey(deps.userId);
    const rest = parseHolds(await deps.store.getItem(key)).filter((h) => !(h.key === hold.key && h.orgId === hold.orgId));
    const raw = serializeHolds(rest);
    if (raw === null) await deps.store.removeItem(key);
    else await deps.store.setItem(key, raw);
  }
  return check;
}
