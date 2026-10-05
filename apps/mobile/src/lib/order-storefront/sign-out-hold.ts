import {
  SIGN_IN_HELD_DROPPED_COPY,
  SIGN_IN_HELD_WITHDRAWN_COPY,
  SIGN_IN_HELD_WITHDRAW_UNANSWERED_COPY,
  SIGN_OUT_WITHDRAW_UNANSWERED_COPY,
  classifyOrderSettleResult,
  formatOrderNumber,
  orderAlreadyPlacedCopy,
  signInHeldPlacedCopy,
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
 *
 * THE EDGES (desk check F5). A status read at sign-out that finds a key
 * placed is said before the session ends ("Your order request SO-… was
 * placed."). "Don't send it" at sign-in always says what happened. A marker
 * that can no longer be checked from this phone is dropped once, with one
 * sentence: its organization is not among the account's memberships (a list
 * that was read; an unread one never drops anything), a call refused for
 * membership, or still unknown 30 days after it was sent.
 */

/** A held key still unknown this long after it was sent is dropped. */
export const ORDER_HOLD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

/** One marker's identity: its organization and key. */
function holdId(h: Pick<OrderSubmissionHold, 'orgId' | 'key'>): string {
  return `${h.orgId}.${h.key}`;
}

/**
 * Every change to an account's markers is a fresh read, the change, and a
 * write, one at a time in this app (PO-4 review, probe P3). The sign-in check
 * runs its status reads for up to 20 s each; a sign-out can hold a new key
 * meanwhile, and a check that wrote back its first read would lose it. Here
 * the check removes only the keys it settled from what the marker holds when
 * it writes. Nothing is written when nothing changed.
 */
let markerChain: Promise<unknown> = Promise.resolve();
export function updateHolds(
  store: Pick<HoldStore, 'getItem' | 'setItem' | 'removeItem'>,
  userId: string,
  change: (holds: OrderSubmissionHold[]) => OrderSubmissionHold[],
): Promise<void> {
  const run = markerChain.then(async () => {
    const key = orderHoldKey(userId);
    const before = parseHolds(await store.getItem(key));
    const after = change(before);
    if (after.length === before.length && after.every((h, i) => holdId(h) === holdId(before[i]!))) return;
    const raw = serializeHolds(after);
    if (raw === null) await store.removeItem(key);
    else await store.setItem(key, raw);
  });
  markerChain = run.catch(() => undefined);
  return run;
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
  /** Refused because this account is not a member of its organization: it
   *  can never be checked from here. */
  | { outcome: 'gone' }
  | { outcome: 'unknown' };

/** Read through core: placed names its order, refused and withdrawn clear
 *  the marker silently, a refusal that names membership drops it, anything
 *  else (none, no answer, any other refusal of the read itself, a 401 that
 *  may be the session) keeps it. An answer for another organization is no
 *  answer. */
export function holdCheckFrom(result: OrderCallResult, orgId: string): HoldCheck {
  const outcome = classifyOrderSettleResult(orderCallResultForOrganization(result, orgId));
  if (!outcome.final) {
    return outcome.why === 'refused' && outcome.reason === 'not_member' ? { outcome: 'gone' } : { outcome: 'unknown' };
  }
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

/**
 * Before this phone's `workspace.` keys are removed (a deliberate sign-out,
 * an account eviction), EVERY account's order requests still not settled on
 * it become that account's own marker (PO-4 review). A session revoked from
 * another device leaves its account's drafts here, rightly, for its own next
 * sign-in; another account's sign-out or an eviction then removes them, and
 * without this their live keys went with no marker and the owner was never
 * asked. Ids and counts only, as hold() writes, each through updateHolds.
 * `except`: keys already settled in this flow, never held again.
 */
export async function holdEveryDeviceSend(store: HoldStore, opts: { except?: ReadonlySet<string> } = {}): Promise<void> {
  const keys = (await store.getAllKeys()).filter((k) => k.startsWith(ORDER_DRAFT_PREFIX));
  if (keys.length === 0) return;
  const entries = await store.multiGet(keys);
  const users = new Set(keys.map((k) => k.slice(ORDER_DRAFT_PREFIX.length).split('.')[0]!).filter((u) => u !== ''));
  for (const userId of users) {
    const adds = unsettledSubmissions(entries, userId, null)
      .filter((s) => !opts.except?.has(`${s.orgId}.${s.pending.key}`))
      .map((s) => holdFor(s));
    if (adds.length > 0) await updateHolds(store, userId, (holds) => mergeHolds(holds, adds));
  }
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
    /** Read each one's status. The orders found placed (their labels), to
     *  say before the session ends. */
    async settle() {
      const placed: (string | null)[] = [];
      for (const s of await live()) {
        const check = holdCheckFrom(await deps.calls.status(scopeOf(s.orgId), s.pending.key), s.orgId);
        if (check.outcome === 'unknown') continue;
        settled.add(`${s.orgId}.${s.pending.key}`);
        if (check.outcome === 'placed') placed.push(check.label);
      }
      return { placed };
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
      await updateHolds(deps.store, deps.userId, (holds) => mergeHolds(holds, adds));
    },
    /** Just before the device's workspace keys go: every account's live
     *  sends on this phone become their owner's marker, except the keys this
     *  sign-out settled (PO-4 review). */
    async holdDevice() {
      await holdEveryDeviceSend(deps.store, { except: settled });
    },
    async report(result: { placed: string[]; unanswered: number }) {
      const lines = result.placed.map((label) =>
        orderAlreadyPlacedCopy({ orderNumber: null, orderLabel: label === '' ? null : label }),
      );
      if (result.unanswered > 0) lines.push(SIGN_OUT_WITHDRAW_UNANSWERED_COPY);
      if (lines.length > 0) await deps.say(lines.join(' '));
    },
    /** Say the orders the status reads found placed ("Your order request
     *  SO-… was placed."). Nothing when there are none. */
    async reportPlaced(labels: readonly (string | null)[]) {
      if (labels.length > 0) await deps.say(labels.map(signInHeldPlacedCopy).join(' '));
    },
  };
}

// ── The next sign-in's half ─────────────────────────────────────────────────

export interface HeldCheckResult {
  /** Orders the held keys turned out to have placed ("SO-000123", or null). */
  placed: (string | null)[];
  /** Still not known: offer "Don't send it" and "See my orders". */
  unknown: OrderSubmissionHold[];
  /** Markers dropped because they can no longer be checked from this phone
   *  (say SIGN_IN_HELD_DROPPED_COPY once). */
  dropped: number;
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
  /** Reads the account's accepted memberships (asked only when a marker is
   *  held). Null, empty or a failed read: not known, so nothing is dropped
   *  for it. */
  memberOrgIds?: () => Promise<readonly string[] | null>;
  now?: () => number;
  /** Still the account that started the check (PO-4 review): a check whose
   *  reads come back after a sign-out changes nothing, so that account's
   *  next sign-in checks the same keys again. */
  current?: () => boolean;
}): Promise<HeldCheckResult> {
  const holds = parseHolds(await deps.store.getItem(orderHoldKey(deps.userId)));
  if (holds.length === 0) return { placed: [], unknown: [], dropped: 0 };
  const onDevice = new Set((await deviceSends(deps.store, deps.userId)).map((s) => `${s.orgId}.${s.pending.key}`));
  const memberIds = deps.memberOrgIds ? await deps.memberOrgIds().catch(() => null) : null;
  const members = memberIds && memberIds.length > 0 ? new Set(memberIds) : null;
  const now = (deps.now ?? Date.now)();
  // What this run settled or dropped: only these leave the marker.
  const done = new Set<string>();
  const placed: (string | null)[] = [];
  const unknown: OrderSubmissionHold[] = [];
  let dropped = 0;
  for (const h of holds) {
    if (onDevice.has(holdId(h))) continue;
    if (members && !members.has(h.orgId)) {
      dropped += 1;
      done.add(holdId(h));
      continue;
    }
    const check = holdCheckFrom(await deps.calls.status({ orgId: h.orgId, userId: deps.userId }, h.key), h.orgId);
    if (check.outcome === 'unknown') {
      const sent = Date.parse(h.sentAt);
      if (Number.isFinite(sent) && now - sent > ORDER_HOLD_MAX_AGE_MS) {
        dropped += 1;
        done.add(holdId(h));
        continue;
      }
      unknown.push(h);
      continue;
    }
    done.add(holdId(h));
    if (check.outcome === 'placed') placed.push(check.label);
    else if (check.outcome === 'gone') dropped += 1;
  }
  if (done.size > 0 && (deps.current?.() ?? true)) {
    await updateHolds(deps.store, deps.userId, (fresh) => fresh.filter((h) => !done.has(holdId(h))));
  }
  return { placed, unknown, dropped };
}

/** What the sign-in check says once its reads are back, in order: each
 *  order found placed, one sentence for the markers dropped, and the held
 *  keys still unknown that this app run has not offered yet. The caller says
 *  nothing at all once its account has gone (runtime.ts). */
export function heldCheckReport(
  result: HeldCheckResult,
  offered: ReadonlySet<string>,
): { sentences: string[]; offers: OrderSubmissionHold[] } {
  const sentences = result.placed.map((label) => signInHeldPlacedCopy(label));
  if (result.dropped > 0) sentences.push(SIGN_IN_HELD_DROPPED_COPY);
  return { sentences, offers: result.unknown.filter((h) => !offered.has(holdId(h))) };
}

/** What "Don't send it" at sign-in says: not sent; already placed (its
 *  label); can no longer be checked here; or, with no answer, that it will be
 *  asked again. */
export function heldWithdrawSentence(check: HoldCheck): string {
  switch (check.outcome) {
    case 'placed':
      return orderAlreadyPlacedCopy({ orderNumber: null, orderLabel: check.label });
    case 'settled':
      return SIGN_IN_HELD_WITHDRAWN_COPY;
    case 'gone':
      return SIGN_IN_HELD_DROPPED_COPY;
    case 'unknown':
      return SIGN_IN_HELD_WITHDRAW_UNANSWERED_COPY;
  }
}

/** "Don't send it" for a held key: withdraw it (its answer is final). */
export async function withdrawHeldSubmission(
  deps: { userId: string; store: HoldStore; calls: HoldCalls },
  hold: OrderSubmissionHold,
): Promise<HoldCheck> {
  const check = holdCheckFrom(await deps.calls.withdraw({ orgId: hold.orgId, userId: deps.userId }, hold.key), hold.orgId);
  if (check.outcome !== 'unknown') {
    await updateHolds(deps.store, deps.userId, (fresh) => fresh.filter((h) => holdId(h) !== holdId(hold)));
  }
  return check;
}
