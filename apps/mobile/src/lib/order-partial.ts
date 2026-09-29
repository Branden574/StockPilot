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
  describePartialPreview,
  describePartialResult,
  PARTIAL_ACTION_TITLE,
  PARTIAL_CLOSE_LABEL,
  PARTIAL_COMMIT_UNANSWERED_COPY,
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
}

/** The sheet's words for a preview, core's throughout. */
export function partialSheetView(
  preview: PartialPreview,
  opts: ReadinessCopyOptions = {},
): PartialSheetView {
  const copy = describePartialPreview(preview);
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

/** A refusal the server did not word, or a request that failed oddly. */
export const PARTIAL_COMMIT_FAILED_COPY = 'The order could not be updated. Try again.';

/**
 * What the sheet says in place when the confirm was refused or failed: the
 * server's sentence (a stock refusal, "not allowed", the order moved on);
 * for no answer at all, that the outcome is unknown (never the network
 * layer's own text, and never "try again" as if nothing happened); a bare
 * code is never shown.
 */
export function describePartialCommitError(e: unknown): string {
  const status =
    typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number'
      ? (e as { status: number }).status
      : null;
  const message = e instanceof Error && e.message ? e.message : null;
  // No answer came back (the connection dropped, the request timed out):
  // whether the approval went through is unknown, so core's sentence, the
  // web dialog's too, says to look before trying again.
  if (status === null) return PARTIAL_COMMIT_UNANSWERED_COPY;
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  // A lone snake_case token is a code, not a sentence.
  if (message && !/^[a-z0-9_]+$/.test(message)) return message;
  return PARTIAL_COMMIT_FAILED_COPY;
}

/**
 * Confirm approve partial or resume: the existing transition, then readiness
 * read again, and the message computed from THAT read (core
 * describePartialResult: the order's own holds now, compared with the
 * preview). A refused commit throws (the sheet shows the server's sentence
 * and stays open); nothing is read or said then. Once the commit went
 * through, nothing here throws: a failed re-read says the holds couldn't be
 * checked, never a number from the preview.
 */
export async function runPartialFulfilment(
  deps: PartialCommitDeps,
  orderId: string,
  action: PartialAction,
  preview: PartialPreview,
): Promise<PartialResultCopy> {
  await deps.commit(orderId, action);
  const [reread] = await Promise.all([
    deps.reread(orderId).catch((): OrderReadinessResult => REREAD_FAILED),
    deps.reload().catch(() => undefined),
  ]);
  return describePartialResult({ action, preview, reread });
}
