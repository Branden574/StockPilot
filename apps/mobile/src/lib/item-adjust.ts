import { adjustItemStock, type AdjustStockBody, type AdjustStockResult } from './stock-api';

/**
 * ITEM SCREEN MANUAL ADJUST — the four quick buttons (-5, -1, +1, +5) and the
 * "Adjust with reason" sheet on app/item/[id].tsx.
 *
 * ═══ WHY THIS GOES THROUGH THE SERVER ═══
 *
 * Until 2026-09-22 the screen called the adjust-stock RPC straight from the
 * phone's Supabase client (the literal call shape is not written here: the
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
 * The scan tab made the same move on 2026-09-05; this is its sibling.
 *
 * ═══ WHY IT IS NOT QUEUED OFFLINE ═══
 *
 * The outbox only carries writes the server can DEDUPE: distribute_bundle
 * replays with the key its direct attempt used (0347). The adjust route takes
 * no idempotency key, so when a request's response is lost after the server
 * committed (a dropped connection, or api()'s 20 s timeout), a queued replay
 * would move the stock a second time. Every other manual stock write on the
 * phone (scan quick-adjust, transfer, remove-from-rack) is online-only for the
 * same reason, and the outbox's `adjust_stock` kind has never been wired. So a
 * failure is SAID, never dropped and never silently retried.
 */

/** The reason stored on the movement when the operator typed none. The
 *  history has always used this label for adjustments made on this screen. */
export const ITEM_ADJUST_DEFAULT_REASON = 'Mobile detail';

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
   * The request may or may not have been written: the connection failed,
   * timed out, or the server answered 5xx. The displayed total can no longer
   * be trusted as current until it is read again from the server.
   */
  | { kind: 'unconfirmed'; alert: AdjustAlert };

export function buildItemAdjustBody(delta: number, reason?: string): AdjustStockBody {
  const trimmed = (reason ?? '').trim();
  return {
    quantityChange: delta,
    // Explicit, as the RPC call it replaces was: a -1 is a REMOVAL in the item
    // history, and Activity and the exports filter on the movement kind.
    movementType: delta > 0 ? 'add' : 'remove',
    reason: trimmed.length > 0 ? trimmed : ITEM_ADJUST_DEFAULT_REASON,
  };
}

const UNCONFIRMED: AdjustAlert = {
  title: 'Adjustment not confirmed',
  message:
    'The app could not confirm this adjustment, so it may or may not have been saved. ' +
    'It was not queued to retry. Pull down to refresh and check the on-hand quantity ' +
    'before adjusting again, so the change is not applied twice.',
};

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
export function classifyAdjustFailure(err: unknown): Exclude<ItemAdjustOutcome, { kind: 'saved' }> {
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
  // permission, archived, insufficient-stock and validation sentences) and
  // never echoes an HTML error page.
  const message = err instanceof Error && err.message ? err.message : null;
  return {
    kind: 'refused',
    alert: {
      title: 'Could not adjust',
      message: message ?? 'The server refused this adjustment. Nothing was changed.',
    },
  };
}

/**
 * Send one manual adjustment. NEVER REJECTS: every outcome comes back as a
 * value, so the screen's bare onPress handlers cannot leak an unobserved
 * rejection and every failure reaches the operator.
 */
export async function submitItemAdjust(
  itemId: string,
  delta: number,
  reason?: string,
  post: (itemId: string, body: AdjustStockBody) => Promise<AdjustStockResult> = adjustItemStock,
): Promise<ItemAdjustOutcome> {
  // The sheet already refuses these; this keeps a zero or NaN from ever
  // costing a round trip (the route would 400 it anyway).
  if (!Number.isFinite(delta) || delta === 0) {
    return {
      kind: 'refused',
      alert: { title: 'Could not adjust', message: 'Enter a non-zero quantity.' },
    };
  }
  let res: AdjustStockResult;
  try {
    res = await post(itemId, buildItemAdjustBody(delta, reason));
  } catch (e) {
    return classifyAdjustFailure(e);
  }
  const q = res?.quantityOnHand;
  return {
    kind: 'saved',
    quantityOnHand: typeof q === 'number' && Number.isFinite(q) ? q : null,
  };
}
