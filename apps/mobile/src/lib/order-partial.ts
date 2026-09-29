/**
 * APPROVE PARTIAL AND RESUME, WITH A PREVIEW, ON THE PHONE (F2-3).
 *
 * The order screen's Approve partial (pending_approval) and Resume
 * fulfillment (backordered) open a sheet first: what would be held now, per
 * item, and what ships when it arrives (core previewPartialFulfilment, the
 * frozen RPCs' twin, never a per-line split: duplicate lines are combined).
 * Confirm calls the existing transition, unchanged (approve_partial /
 * resume_fulfillment through POST /api/v1/orders/[id]/transition). Then the
 * phone reads readiness AGAIN and says what was actually held, from that
 * read's own holds (heldOwn), never from the preview: "Approved. Holding 34 of
 * 40 units, 2 fewer than shown because stock changed after you looked."
 *
 * The preview is taken from the readiness the screen shows (the card's
 * "Checked at"), frozen when the sheet opens: the result is compared with what
 * the reader looked at. An unavailable preview (a failed or capped check, an
 * item the reader cannot see, an item now in another warehouse, nothing to
 * hold) says why and offers nothing to confirm: the button that opens the
 * sheet is already disabled with the reason in those cases (core
 * orderStockGates), and nothing is committed blind.
 *
 * Every word is core's (partial-fulfilment.ts, readiness-copy.ts), so the
 * phone and the web order page say the same thing. Pure: no React Native
 * import, no API client (the screen passes the calls in).
 */

import {
  describePartialCommitRefusal,
  describePartialPreview,
  describePartialResult,
  PARTIAL_ACTION_TITLE,
  PARTIAL_CLOSE_LABEL,
  partialActionApplies,
  partialActionMovedOnCopy,
  readinessCheckedAtCopy,
  type OrderReadinessResult,
  type PartialAction,
  type PartialPreview,
  type PartialPreviewItemCopy,
  type PartialResultCopy,
  type ReadinessCopyOptions,
} from '@stockpilot/core';

export interface PartialSheetView {
  title: string;
  /** "Approve what's available: holds 36 of 40 units now. The other 4 ship
   *  when they arrive." Null when the preview is unavailable. */
  summary: string | null;
  /** "Checked at 2:14 PM. Stock can change after this." */
  checkedAt: string | null;
  /** One entry per item (duplicate lines combined), in line order. */
  items: PartialPreviewItemCopy[];
  /** "Picking takes what's on the shelf; the rest ships when it arrives." */
  note: string | null;
  /** Null: nothing may be confirmed (the preview is unavailable). */
  confirmLabel: string | null;
  cancelLabel: string;
  /** Why no preview can be shown (core's sentence), or null. */
  unavailable: string | null;
  /**
   * The order is no longer at the status the action starts from (another
   * approver got there first; the screen reloads after a refusal): core's
   * sentence, and the sheet offers Close instead of Confirm. Null while it
   * still applies, or before the screen knows the status.
   */
  movedOn: string | null;
}

/** The sheet's words for a preview, core's throughout. `orderStatus` is the
 *  order's status as the screen shows it NOW (the preview is frozen). */
export function partialSheetView(
  preview: PartialPreview,
  opts: ReadinessCopyOptions & { orderStatus?: string | null } = {},
): PartialSheetView {
  const copy = describePartialPreview(preview);
  const status = opts.orderStatus ?? null;
  const movedOn =
    status !== null && !partialActionApplies(preview.action, status)
      ? partialActionMovedOnCopy(preview.action)
      : null;
  if (preview.state !== 'ok' || !copy) {
    return {
      title: PARTIAL_ACTION_TITLE[preview.action],
      summary: null,
      checkedAt: null,
      items: [],
      note: null,
      confirmLabel: null,
      cancelLabel: PARTIAL_CLOSE_LABEL,
      unavailable: preview.state === 'unavailable' ? preview.message : null,
      movedOn: null,
    };
  }
  return {
    title: copy.title,
    summary: copy.summary,
    checkedAt: readinessCheckedAtCopy(preview.observedAt, opts),
    items: copy.items,
    note: copy.note,
    confirmLabel: copy.confirmLabel,
    cancelLabel: copy.cancelLabel,
    unavailable: null,
    movedOn,
  };
}

/** What the confirm needs from the screen. */
export interface PartialCommitDeps {
  /** The existing transition, unchanged (orders-api commitPartialFulfilment).
   *  Throws the server's refusal. */
  commit: (orderId: string, action: PartialAction) => Promise<void>;
  /** Readiness read again after the commit (lib/order-readiness
   *  readOrderReadiness; never throws, a failure is `{ state: 'failed' }`). */
  reread: (orderId: string) => Promise<OrderReadinessResult>;
  /** The screen's own reload, run beside the re-read (no serial round trip). */
  reload: () => Promise<void>;
}

/** A re-read that could not be made: the message then claims no number. */
const REREAD_FAILED: OrderReadinessResult = {
  state: 'failed',
  message: "Couldn't check readiness.",
};

/**
 * What the sheet says in place when the confirm was refused or failed, in
 * core's words, the web dialog's too (describePartialCommitRefusal): the
 * server's sentence for a refusal it worded; for no answer at all, or a
 * gateway error the app never answered, that the outcome is unknown (look
 * before trying again); for a server error, core's sentence rather than the
 * database's text; too many requests, core's; a bare code is never shown.
 */
export function describePartialCommitError(e: unknown): string {
  const status =
    typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number'
      ? (e as { status: number }).status
      : null;
  const code =
    typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
      ? (e as { code: string }).code
      : null;
  const message = e instanceof Error && e.message ? e.message : null;
  // No status: nothing came back (the connection dropped, the request timed
  // out), never the network layer's own words.
  if (status === null) return describePartialCommitRefusal({ answered: false });
  return describePartialCommitRefusal({ answered: true, status, code, message });
}

/**
 * Confirm approve partial or resume: the existing transition, then readiness
 * read again, and the message computed from THAT read (core
 * describePartialResult: the order's own holds now, compared with the
 * preview). A refused commit throws (the sheet shows the server's sentence
 * and stays open); nothing is read for a message then, but the screen reloads
 * behind the sheet (not awaited: the refusal is said at once), so an order
 * that moved on shows where it is and the sheet offers Close. Once the commit
 * went through, nothing here throws: a failed re-read says the holds couldn't
 * be checked, never a number from the preview.
 */
export async function runPartialFulfilment(
  deps: PartialCommitDeps,
  orderId: string,
  action: PartialAction,
  preview: PartialPreview,
): Promise<PartialResultCopy> {
  try {
    await deps.commit(orderId, action);
  } catch (e) {
    deps.reload().catch(() => undefined);
    throw e;
  }
  const [reread] = await Promise.all([
    deps.reread(orderId).catch((): OrderReadinessResult => REREAD_FAILED),
    deps.reload().catch(() => undefined),
  ]);
  return describePartialResult({ action, preview, reread });
}
