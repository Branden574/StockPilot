import { classifyDrainFailure } from './drain-failure';
import { UNCONFIRMED_SETTLE_MS } from './unconfirmed-stock';

import type { AdjustStockBody } from './stock-api';

/**
 * THE OFFLINE STOCK ADJUSTMENT — outbox kind `adjust_stock`.
 *
 * A -5/-1/+1/+5 or "Adjust with reason" tapped on the item screen with NO
 * connection is saved as one pending_actions row (queue.ts enqueue, which
 * stamps it with the workspace and account it was queued under, S4). The
 * drain (sync.ts) replays it to POST /api/v1/items/<id>/adjust, the route the
 * online tap uses, with the SAME body: the stock:adjust permission and the
 * MFA gate, the warehouse write scope, the archived-item refusal, the audit
 * row, the rack/Unplaced resolution for an add and draw mode 'any' for a
 * removal all apply exactly as they do online.
 *
 * ═══ AT MOST ONCE ═══
 *
 * The route takes no idempotency key. distribute_bundle can be replayed
 * blindly because its server recognises a replay (0347); this route cannot,
 * so a request whose ANSWER was lost after the server committed would move the
 * stock again if it were re-sent. Every outcome is therefore decided on what
 * the phone can prove about the attempt, never retried on hope:
 *
 *   • ok (2xx): written; the row is deleted.
 *   • REJECTED: the server evaluated it and refused (400, 403, 409, 422, a
 *     404 carrying our JSON code, a 401 on a disabled account — the rule
 *     drain-failure.ts applies to every kind), or the row is malformed.
 *     Nothing was written. Parked in Settings > Unsent work with the item
 *     and the server's reason.
 *   • FAILED (retried next tick): provably not written. The request never
 *     left the phone (api() never handed it to fetch: no session, a session
 *     read that failed), or it was answered BEFORE the route could write: a
 *     401 on a live account (withApiContext refuses first), a 429 (the rate
 *     limit runs first, and an edge 429 never reaches the route) or a
 *     framework 404 with no JSON code (no such route on that server).
 *   • UNCONFIRMED: handed to fetch, and then no answer that proves either
 *     way — a network error, api()'s timeout, a 5xx (the route can answer
 *     500 after the commit), anything else. It MAY have been saved. It is
 *     parked, never re-sent, with a message that says so and names the item,
 *     so the operator checks the on-hand before entering it again. A row
 *     found still 'sending' at app start (the app died mid-send) is parked
 *     the same way (db.ts initDb), where every other kind is re-queued.
 *
 * The cost is a human check on a lost answer, which is rare: the drain only
 * sends once the phone reports a connection. The alternative costs a silent
 * double count. Server-side dedupe (a key the RPC records with the movement)
 * would let this kind retry like the others; it needs a migration.
 *
 * ═══ ONE LOST ANSWER, NOT SIX ═══
 *
 * A lost answer is usually a lost CONNECTION, and every row sent after it on
 * the same dead link fails the same way after its own hand-off, so each one
 * would be parked "Not confirmed" although none reached the server. So a
 * queued adjustment is only handed off while the server has just answered
 * this phone (adjustSendGate below): the snapshot pull that opens every sync
 * pass is the probe, and a lost answer closes the gate until the next pull
 * gets an answer. The drain also re-reads the phone's network state before
 * each adjustment (sync.ts).
 *
 * FREE OF NATIVE MODULES on purpose: sync.ts, db.ts and queue.ts need
 * expo-sqlite, and the decisions worth pinning live here so vitest can execute
 * them. Pure functions, except the one send gate at the bottom (module state).
 */

export const ADJUST_STOCK_KIND = 'adjust_stock';

/** The row, as the drain reads it back. */
export interface QueuedAdjust {
  itemId: string;
  /** Exactly what POST /api/v1/items/<id>/adjust receives. */
  body: AdjustStockBody;
  /** What the item was called when queued: for the operator's record only,
   *  never sent. Null on a row that did not carry one. */
  itemLabel: string | null;
}

/** A row the drain can never send (no item, a zero or non-numeric change). */
export class QueuedAdjustInvalidError extends Error {
  constructor(detail: string) {
    super(`This queued stock adjustment is incomplete (${detail}) and cannot be sent.`);
    this.name = 'QueuedAdjustInvalidError';
  }
}

/**
 * The note the movement carries, so the item history says the change was
 * made offline and WHEN: the movement's own timestamp is the moment the phone
 * reconnected and sent it, which can be hours later.
 */
export function offlineAdjustNote(queuedAt: number): string {
  return `Queued offline on the phone at ${new Date(queuedAt).toISOString()} (phone clock).`;
}

/** The payload stored on the outbox row. */
export function queuedAdjustPayload(input: {
  itemId: string;
  body: AdjustStockBody;
  itemLabel?: string | null;
  queuedAt: number;
}): Record<string, unknown> {
  const label = (input.itemLabel ?? '').trim();
  return {
    itemId: input.itemId,
    quantityChange: input.body.quantityChange,
    ...(input.body.movementType ? { movementType: input.body.movementType } : {}),
    ...(input.body.reason ? { reason: input.body.reason } : {}),
    notes: offlineAdjustNote(input.queuedAt),
    ...(label ? { itemLabel: label.slice(0, 200) } : {}),
  };
}

const MOVEMENT_TYPES = new Set(['add', 'remove', 'adjust']);

/** Reads a stored payload back. Throws QueuedAdjustInvalidError when it is unusable. */
export function parseQueuedAdjust(payload: Record<string, unknown>): QueuedAdjust {
  const itemId = typeof payload.itemId === 'string' ? payload.itemId.trim() : '';
  if (!itemId) throw new QueuedAdjustInvalidError('no item');
  const q = payload.quantityChange;
  if (typeof q !== 'number' || !Number.isFinite(q) || q === 0) {
    throw new QueuedAdjustInvalidError('no quantity');
  }
  const movementType =
    typeof payload.movementType === 'string' && MOVEMENT_TYPES.has(payload.movementType)
      ? (payload.movementType as AdjustStockBody['movementType'])
      : undefined;
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  const notes = typeof payload.notes === 'string' ? payload.notes : undefined;
  return {
    itemId,
    body: {
      quantityChange: q,
      ...(movementType ? { movementType } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
    itemLabel: typeof payload.itemLabel === 'string' && payload.itemLabel ? payload.itemLabel : null,
  };
}

export type AdjustDrainVerdict = 'rejected' | 'failed' | 'unconfirmed';

/**
 * What one failed send of an `adjust_stock` row means. See the header for
 * each class. `handedOff` is whether api() handed the request to fetch
 * (its onSend hook): before that moment nothing can have reached the server.
 */
export function adjustDrainVerdict(
  err: unknown,
  opts: { accountDisabled: boolean; handedOff: boolean },
): AdjustDrainVerdict {
  if (err instanceof QueuedAdjustInvalidError) return 'rejected';
  if (!opts.handedOff) return 'failed';
  if (classifyDrainFailure(err, { accountDisabled: opts.accountDisabled }) === 'rejected') {
    return 'rejected';
  }
  const e = err as { status?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : null;
  // Answered before the route could write (a 404 WITH our code was a verdict
  // about the item, and was rejected above).
  if (status === 401 || status === 429 || status === 404) return 'failed';
  return 'unconfirmed';
}

/** "+1 to Polo S (POLO-S)", from a stored payload; never throws. */
export function describeQueuedAdjust(payload: Record<string, unknown>): string {
  const q = typeof payload.quantityChange === 'number' ? payload.quantityChange : NaN;
  const change = Number.isFinite(q) ? (q > 0 ? `+${q}` : `−${Math.abs(q)}`) : 'A change';
  const label =
    typeof payload.itemLabel === 'string' && payload.itemLabel.trim()
      ? payload.itemLabel.trim()
      : 'an item';
  return `${change} to ${label}`;
}

/**
 * Every unconfirmed row's last_error starts with this. Settings > Unsent work
 * lists those rows apart ("Not confirmed"), because unlike the rest of that
 * list they may have been applied.
 */
export const UNCONFIRMED_ADJUST_PREFIX = 'Not confirmed: ';

const SETTLE_SECONDS = Math.round(UNCONFIRMED_SETTLE_MS / 1000);

/**
 * The server keeps running after the phone stops waiting (the route's 30 s
 * maxDuration plus the database's own bound; unconfirmed-stock.ts), so a
 * check made the moment the row is parked can miss a write that is still
 * committing, and re-entering it then counts the stock twice.
 */
const CHECK_BEFORE_REENTERING =
  'It was not sent again, so it cannot be applied twice. If it was saved, it shows within ' +
  `${SETTLE_SECONDS} seconds of being sent. After that, check the item’s on-hand quantity ` +
  'and history, and adjust again only if the change is missing.';

/** last_error for a send whose answer never came back. */
export function unconfirmedQueuedAdjustMessage(payload: Record<string, unknown>): string {
  return (
    `${UNCONFIRMED_ADJUST_PREFIX}${describeQueuedAdjust(payload)} was sent, but no answer came ` +
    `back, so it may or may not have been saved. ${CHECK_BEFORE_REENTERING}`
  );
}

/** last_error for a row the app closed on while it was being sent. */
export function orphanedQueuedAdjustMessage(payload: Record<string, unknown>): string {
  return (
    `${UNCONFIRMED_ADJUST_PREFIX}${describeQueuedAdjust(payload)} was being sent when the app ` +
    `closed, so it may or may not have been saved. ${CHECK_BEFORE_REENTERING}`
  );
}

/**
 * last_error for a row that was being sent when the person chose "Sign out
 * and discard" (queue.ts discardUnsyncedFor). A request already handed to
 * fetch cannot be called back: the server may still commit it. Deleting the
 * row there left no record of a write that may land, so it is parked instead.
 */
export function discardedInFlightAdjustMessage(payload: Record<string, unknown>): string {
  return (
    `${UNCONFIRMED_ADJUST_PREFIX}${describeQueuedAdjust(payload)} was already being sent when ` +
    `unsent changes were discarded at sign-out, so it may or may not have been saved. ` +
    CHECK_BEFORE_REENTERING
  );
}

/**
 * The refusal reason to record, from the error the drain caught. api() falls
 * back to the body's `error` CODE when there is no `message`, and the route
 * answers a 401 with a bare { error: 'unauthenticated' }; a 401 is only a
 * refusal for this kind on an account the phone knows is disabled
 * (adjustDrainVerdict), so it is said in words, as item-adjust.ts does online.
 */
export function queuedAdjustRefusalReason(err: unknown, message: string): string {
  const e = err as { status?: unknown } | null | undefined;
  if (e?.status === 401) return 'This account was disabled when it was sent';
  return message;
}

/** last_error for a refusal: which change, and the server's sentence. */
export function refusedQueuedAdjustMessage(
  payload: Record<string, unknown>,
  serverMessage: string,
): string {
  const m = serverMessage.trim() || 'The server refused it.';
  const sentence = /[.!?]$/.test(m) ? m : `${m}.`;
  return `${describeQueuedAdjust(payload)}: ${sentence} Nothing was changed.`;
}

/** Whether a rejected outbox row is an adjustment that MAY have been applied. */
export function isUnconfirmedAdjustRow(row: { kind: string; lastError: string | null }): boolean {
  return (
    row.kind === ADJUST_STOCK_KIND &&
    typeof row.lastError === 'string' &&
    row.lastError.startsWith(UNCONFIRMED_ADJUST_PREFIX)
  );
}

/*
 * ── SQL ─────────────────────────────────────────────────────────────────────
 * Exported so adjust-outbox.sqlite.test.ts runs them against the real schema.
 */

/** App start: this kind's rows orphaned mid-send (db.ts initDb parks them). */
export const ORPHANED_ADJUST_SELECT_SQL = `
  select id, payload_json from pending_actions
   where status = 'sending' and kind = 'adjust_stock'`;

/** Params: (last_error, now, id). */
export const PARK_ORPHANED_ADJUST_SQL = `
  update pending_actions
     set status = 'rejected', last_error = ?, last_attempt_at = ?
   where id = ? and status = 'sending'`;

/**
 * "Sign out and discard": the account's adjustments in flight right now
 * (queue.ts discardUnsyncedFor parks them with PARK_ORPHANED_ADJUST_SQL
 * instead of deleting them). Params: (user id). `owned` as below.
 */
export function inFlightAdjustForUserSql(owned: string): string {
  return `
  select id, payload_json from pending_actions
   where status = 'sending' and kind = 'adjust_stock'
     and ${owned}`;
}

/**
 * The live account's unsent adjustments for ONE item (legacy rows included,
 * as every outbox counter does). Params: (itemId, live user id or null).
 * `owned` is outbox-scope.ts OWNED_BY_USER_SQL, passed in to keep this module
 * free of that file's imports.
 */
export function pendingAdjustForItemSql(owned: string): string {
  return `
  select count(*) as n,
         coalesce(sum(cast(json_extract(payload_json, '$.quantityChange') as real)), 0) as net
    from pending_actions
   where kind = 'adjust_stock'
     and status in ('pending','failed','sending')
     and json_extract(payload_json, '$.itemId') = ?
     and ${owned}`;
}

/** Rejected rows that are unconfirmed adjustments. Params: (prefix, prefix, live user id). */
export function countUnconfirmedAdjustSql(owned: string): string {
  return `
  select count(*) as n from pending_actions
   where status = 'rejected'
     and kind = 'adjust_stock'
     and substr(last_error, 1, length(?)) = ?
     and ${owned}`;
}

/** "+3" / "−2" for the item screen's queued note. */
export function formatQueuedNet(net: number): string {
  if (!Number.isFinite(net) || net === 0) return '0';
  return net > 0 ? `+${net}` : `−${Math.abs(net)}`;
}

/**
 * What is queued for one item, for the ON HAND note and the Adjust sheet:
 * "+1" for one change, "2 changes, net 0" for more. Two or more can net to 0
 * ("+1" then "-1"), and a bare "0" reads as nothing queued.
 */
export function describeQueuedChanges(q: { count: number; net: number }): string {
  return q.count > 1 ? `${q.count} changes, net ${formatQueuedNet(q.net)}` : formatQueuedNet(q.net);
}

/*
 * ── THE SEND GATE ──────────────────────────────────────────────────────────
 */

/**
 * Whether a queued adjustment may be handed off now. See "ONE LOST ANSWER,
 * NOT SIX" in the header.
 *
 * Open only while the LAST thing the phone learned about the link is that the
 * server answered it: the snapshot pull at the start of each sync pass
 * reports every answer (any HTTP status; the round trip worked) and every
 * failure with no answer (sync.ts pullSnapshot). A lost adjustment answer
 * closes it for the rest of that pass and for every later pass whose pull
 * gets no answer. Closed at app start, until the first pull answers.
 *
 * Only this kind waits on it: every other kind carries an idempotency key and
 * is retried safely.
 */
export interface AdjustSendGate {
  /** The server answered a request (any HTTP status). */
  serverAnswered(): void;
  /** A request got no answer: a network error or a timeout. */
  noAnswer(): void;
  canSend(): boolean;
  /** Tests only: back to the app-start state (closed). */
  resetForTests(): void;
}

export function createAdjustSendGate(): AdjustSendGate {
  let answered = false;
  return {
    serverAnswered: () => {
      answered = true;
    },
    noAnswer: () => {
      answered = false;
    },
    canSend: () => answered,
    resetForTests: () => {
      answered = false;
    },
  };
}

/** The app's one gate: module state, as long as the JS runtime lives. */
export const adjustSendGate = createAdjustSendGate();

/** Whether a caught error carries an HTTP answer (api()'s ApiError status). */
export function wasAnswered(err: unknown): boolean {
  const e = err as { status?: unknown } | null | undefined;
  return typeof e?.status === 'number';
}
