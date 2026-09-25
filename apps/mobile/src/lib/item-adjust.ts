import { queuedAdjustPayload } from './adjust-outbox';
import {
  adjustItemStock,
  type AdjustSendHooks,
  type AdjustStockBody,
  type AdjustStockResult,
} from './stock-api';
import { UNCONFIRMED_SETTLE_MS, unconfirmedStock } from './unconfirmed-stock';

/**
 * MANUAL ADJUST FROM THE PHONE — the item screen's four quick buttons (-5, -1,
 * +1, +5) and "Adjust with reason" sheet (app/item/[id].tsx), and the scan
 * tab's quick adjust (-1, +1, +5, +25; app/(drawer)/(tabs)/scan.tsx). One
 * sender, so a timeout means the same thing on both screens.
 *
 * ═══ WHY THIS GOES THROUGH THE SERVER ═══
 *
 * Until 2026-09-22 the item screen called the adjust-stock RPC straight from
 * the phone's Supabase client (the literal call shape is not written here: the
 * guard in no-direct-adjust-rpc.test.ts greps every shipped source file for
 * it). That skipped everything POST /api/v1/items/<id>/adjust adds:
 *
 *   • the 'stock:adjust' PERMISSION and the MFA gate — the RPC checks only the
 *     staff-role floor (0327), so a staffer whose stock:adjust was revoked
 *     (a 0207 override) kept adjusting from the phone;
 *   • the item's warehouse WRITE scope and the archived-item refusal;
 *   • the audit row and the stock.low webhook;
 *   • the rack/Unplaced resolution for a manual add — a null-location +1 fed
 *     to the RPC lands in STAGING (0341) and shows up in the put-away list as
 *     if it were an unprocessed receipt;
 *   • the invalidation of the web's cached Items view. This is the one that
 *     was measured: in the 30 days to 2026-09-22 five adjustments took this
 *     path, and they were the only stock writes that bypassed the cache
 *     invalidation, so each left a manager's Items list showing the old
 *     on-hand total for up to the 60 s cache window.
 *
 * The scan tab made the same move on 2026-09-05 with its own inline POST; since
 * 2026-09-22 it sends through submitItemAdjust too, so its timeouts are
 * reported as unconfirmed instead of "Could not adjust" (which read as "nothing
 * happened, tap again" on a write that may have landed).
 *
 * ═══ OFFLINE: QUEUED ONLY WHEN IT NEVER LEFT THE PHONE ═══
 *
 * The item screen passes `offline` (SubmitItemAdjustOptions). When the phone
 * reports NO connection at the tap, the adjustment is not attempted: it is
 * saved in the outbox and sent later by the drain, at most once, through this
 * same route (adjust-outbox.ts has the rules). That is safe precisely because
 * nothing was sent.
 *
 * A request that WAS sent and then failed is never queued. The adjust route
 * takes no idempotency key, so when a response is lost after the server
 * committed (a dropped connection, or api()'s 20 s timeout), a queued replay
 * would move the stock a second time. So an online failure is SAID —
 * refused, or unconfirmed with the number labelled — never silently retried.
 * The scan tab passes no `offline` and stays online-only, like the other
 * manual stock writes on the phone (transfer, remove-from-rack): it cannot
 * show an item without reading it from the server first.
 */

/** The reason stored on the movement when the operator typed none. The
 *  history has always used this label for adjustments made on this screen. */
export const ITEM_ADJUST_DEFAULT_REASON = 'Mobile detail';
/** The scan tab's label in the item history, unchanged since 2026-09-05. */
export const SCAN_ADJUST_REASON = 'Mobile scan';

export interface AdjustAlert {
  title: string;
  message: string;
}

export type ItemAdjustOutcome =
  /**
   * The server wrote it. `quantityOnHand` is the total the atomic RPC
   * returned — the number to display. Null only if the answer lacked it,
   * in which case the screen must re-read rather than add the delta itself.
   */
  | { kind: 'saved'; quantityOnHand: number | null }
  /** The server evaluated the request and said no. Nothing was written. */
  | { kind: 'refused'; alert: AdjustAlert }
  /**
   * The request may or may not have been written, and may still be running:
   * the connection failed, timed out, or the server answered 5xx. The item is
   * now in unconfirmed-stock.ts, which keeps its total labelled until a read
   * shows the write or the write can no longer land.
   */
  | { kind: 'unconfirmed'; alert: AdjustAlert }
  /**
   * No connection, so nothing was sent: the adjustment is in the outbox and
   * the drain sends it when the phone is back online (adjust-outbox.ts). The
   * on-hand total does not change until then.
   */
  | { kind: 'queued'; alert: AdjustAlert };

export function buildItemAdjustBody(
  delta: number,
  reason?: string,
  defaultReason: string = ITEM_ADJUST_DEFAULT_REASON,
): AdjustStockBody {
  const trimmed = (reason ?? '').trim();
  return {
    quantityChange: delta,
    // Explicit, as the RPC call it replaces was: a -1 is a REMOVAL in the item
    // history, and Activity and the exports filter on the movement kind.
    movementType: delta > 0 ? 'add' : 'remove',
    reason: trimmed.length > 0 ? trimmed : defaultReason,
  };
}

const SETTLE_SECONDS = Math.round(UNCONFIRMED_SETTLE_MS / 1000);

const UNCONFIRMED: AdjustAlert = {
  title: 'Adjustment not confirmed',
  message:
    'The app could not confirm this adjustment, so it may or may not have been saved, ' +
    'and it may still be saving. It was not queued to retry. The on-hand quantity stays ' +
    `marked "Not confirmed" until the app sees the change, or for up to ${SETTLE_SECONDS} ` +
    'seconds, after which it checks again. Check it before adjusting again, so the change ' +
    'is not applied twice.',
};

/** Every 4xx means nothing was written; the operator must be told so. */
const NOTHING_CHANGED = 'Nothing was changed.';

function withNothingChanged(message: string): string {
  const m = message.trim();
  if (m.includes(NOTHING_CHANGED)) return m;
  return `${/[.!?]$/.test(m) ? m : `${m}.`} ${NOTHING_CHANGED}`;
}

/**
 * Refusal or uncertainty, decided on the numeric HTTP status only (the same
 * rule drain-failure.ts keeps: `code` is sometimes a sentence, never a
 * contract).
 *
 * EVERY 4xx means nothing was written. The route performs the write last,
 * after rate limiting, validation, the permission and MFA gates and the
 * service's own refusals; a framework 404 (a server without the route) or an
 * edge 429 never reaches it at all. Anything else — no status (network error,
 * api()'s timeout) or a 5xx (a gateway timeout can arrive after the commit) —
 * is unconfirmed.
 */
export function classifyAdjustFailure(
  err: unknown,
): Exclude<ItemAdjustOutcome, { kind: 'saved' } | { kind: 'queued' }> {
  const e = err as { status?: unknown; details?: unknown } | null | undefined;
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status === null || status < 400 || status >= 500) {
    return { kind: 'unconfirmed', alert: UNCONFIRMED };
  }

  const reason =
    e?.details && typeof e.details === 'object'
      ? (e.details as { reason?: unknown }).reason
      : undefined;
  if (status === 403 && reason === 'aal2_required') {
    // The phone has no in-place TOTP step-up; a session reaches AAL2 only at
    // sign-in (auth-context.tsx). This is reachable when the factor was
    // enrolled on the web AFTER this phone signed in — the same case
    // change-email.tsx explains with the same instruction.
    return {
      kind: 'refused',
      alert: {
        title: 'Sign in again to adjust stock',
        message:
          'Your account uses an authenticator app, and this session has not been verified ' +
          'with it. Sign out, sign back in with your code, then try again. Nothing was changed.',
      },
    };
  }
  if (status === 401) {
    // The route answers a bare { error: 'unauthenticated' }, which api() would
    // otherwise put on screen as that code word.
    return {
      kind: 'refused',
      alert: {
        title: 'Could not adjust',
        message: 'Your session has ended. Sign in again, then retry. Nothing was changed.',
      },
    };
  }
  // api() has already reduced the body to the server's friendly message (the
  // permission, warehouse, archived, insufficient-stock and validation
  // sentences) and never echoes an HTML error page.
  const message = err instanceof Error && err.message ? err.message : null;
  if (status === 403) {
    // Not allowed: a missing stock:adjust, or an item in a warehouse this
    // member cannot write to. The warehouse refusal reached the phone as a 500
    // until 2026-09-22, which this file had to call "may or may not have been
    // saved"; it now arrives as the 403 it is.
    return {
      kind: 'refused',
      alert: {
        title: 'Not allowed to adjust',
        message: withNothingChanged(message ?? 'You do not have access to adjust this item.'),
      },
    };
  }
  return {
    kind: 'refused',
    alert: {
      title: 'Could not adjust',
      message: withNothingChanged(message ?? 'The server refused this adjustment.'),
    },
  };
}

export interface SubmitItemAdjustOptions {
  /** The sheet's typed reason; blank falls back to `defaultReason`. */
  reason?: string;
  /** What the history calls an adjustment from this screen. */
  defaultReason?: string;
  /**
   * The on-hand total on screen when the operator tapped. With the delta it
   * is the total that proves an unconfirmed write landed (unconfirmed-stock.ts).
   */
  shownTotal: number;
  /**
   * Queue the adjustment when the phone has no connection (the item screen).
   * Omitted = online only (the scan tab).
   */
  offline?: OfflineAdjustQueue;
}

/** How a screen that allows it saves an adjustment made with no connection. */
export interface OfflineAdjustQueue {
  /** Whether the phone has a connection now (sync.ts isOnline). */
  isOnline: () => Promise<boolean>;
  /** Saves the row (queue.ts enqueue('adjust_stock', payload)), which stamps
   *  it with this workspace and account and throws when neither is known. */
  enqueue: (payload: Record<string, unknown>) => Promise<unknown>;
  /** The item's name and SKU, kept on the row so Unsent work can name it. */
  itemLabel?: string | null;
  /** The clock, for the note the movement carries. Date.now in the app. */
  now?: () => number;
}

function signedDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `\u2212${Math.abs(delta)}`;
}

/**
 * Save the adjustment in the outbox. Never rejects. The screen shows the
 * alert; the total is NOT changed (nothing was written yet).
 */
async function queueOffline(
  itemId: string,
  delta: number,
  opts: SubmitItemAdjustOptions,
  offline: OfflineAdjustQueue,
): Promise<ItemAdjustOutcome> {
  const body = buildItemAdjustBody(delta, opts.reason, opts.defaultReason);
  try {
    await offline.enqueue(
      queuedAdjustPayload({
        itemId,
        body,
        itemLabel: offline.itemLabel ?? null,
        queuedAt: (offline.now ?? Date.now)(),
      }),
    );
  } catch (e) {
    // queue.ts refuses when no account can be named as the row's owner
    // (OutboxOwnerUnknownError), or the local database failed. Nothing was
    // saved and nothing was sent.
    const message = e instanceof Error && e.message ? e.message : 'This phone could not save it.';
    return {
      kind: 'refused',
      alert: {
        title: 'Could not save offline',
        message: `There is no connection, and this adjustment could not be saved on the phone: ${withNothingChanged(message)}`,
      },
    };
  }
  return {
    kind: 'queued',
    alert: {
      title: 'Saved offline',
      message:
        `There is no connection, so this ${signedDelta(delta)} is saved on this phone and is ` +
        'sent when it is back online. The on-hand quantity changes after that. If the server ' +
        'refuses it, it is listed in Settings > Unsent work.',
    },
  };
}

/** sync.ts isOnline() never throws; an injected one might. Unknown = try online. */
async function reportsOffline(offline: OfflineAdjustQueue): Promise<boolean> {
  try {
    return !(await offline.isOnline());
  } catch {
    return false;
  }
}

/** How a manual adjustment is sent. adjustItemStock in the app; a stub in tests. */
export type AdjustPost = (
  itemId: string,
  body: AdjustStockBody,
  hooks: AdjustSendHooks,
) => Promise<AdjustStockResult>;

/**
 * Send one manual adjustment and record what the answer means for the item's
 * on-hand total in unconfirmed-stock.ts, so every screen showing the item
 * labels it the same way. NEVER REJECTS: every outcome comes back as a value,
 * so the screens' bare onPress handlers cannot leak an unobserved rejection
 * and every failure reaches the operator.
 */
export async function submitItemAdjust(
  itemId: string,
  delta: number,
  opts: SubmitItemAdjustOptions,
  post: AdjustPost = adjustItemStock,
): Promise<ItemAdjustOutcome> {
  // The sheet already refuses these; this keeps a zero or NaN from ever
  // costing a round trip (the route would 400 it anyway).
  if (!Number.isFinite(delta) || delta === 0) {
    return {
      kind: 'refused',
      alert: { title: 'Could not adjust', message: 'Enter a non-zero quantity.' },
    };
  }
  // No connection: nothing is sent, so queueing cannot double anything.
  // Decided BEFORE any write is registered below: a queued change is not in
  // flight and must not label the number as unconfirmed.
  if (opts.offline && (await reportsOffline(opts.offline))) {
    return queueOffline(itemId, delta, opts, opts.offline);
  }
  // Registered before the request leaves: while it is in flight, a read that
  // shows another write's "base + delta" may be THIS write landing instead.
  const write = unconfirmedStock.beginWrite(itemId, { shownTotal: opts.shownTotal, delta });
  // When api() handed the request to fetch: the earliest the server can have
  // it, so the "may still land" window starts here. NOT at the tap: api()
  // first awaits the session, and a token refresh there can take seconds, so
  // a window counted from the tap could close while the write could still
  // land.
  let handedOffAt: number | null = null;
  let res: AdjustStockResult;
  try {
    res = await post(itemId, buildItemAdjustBody(delta, opts.reason, opts.defaultReason), {
      onSend: () => {
        handedOffAt = Date.now();
      },
    });
  } catch (e) {
    const outcome = classifyAdjustFailure(e);
    if (outcome.kind === 'unconfirmed') {
      // No hand-off reported (a sender without the hook, or one that failed
      // before fetch): start from now, the failure. Every hand-off happened
      // before it, and api() fails at most its own timeout after the hand-off,
      // so this can only keep the label up longer, by at most that timeout.
      write.unconfirmed(handedOffAt ?? Date.now());
    } else {
      write.refused();
    }
    return outcome;
  }
  const q = res?.quantityOnHand;
  if (typeof q === 'number' && Number.isFinite(q)) {
    write.confirmed();
    return { kind: 'saved', quantityOnHand: q };
  }
  write.committedWithoutTotal(Date.now());
  return { kind: 'saved', quantityOnHand: null };
}
