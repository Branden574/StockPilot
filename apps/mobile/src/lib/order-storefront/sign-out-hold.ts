import {
  classifyOrderSettleResult,
  formatOrderNumber,
  orderCallResultForOrganization,
  type OrderCallResult,
  type PendingOrderSubmission,
} from '@stockpilot/core';

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
