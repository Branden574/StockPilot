/**
 * APPROVE PARTIAL AND RESUME, WITH A PREVIEW (F2-3).
 *
 * "Approve partial" (pending_approval) and "Resume fulfillment" (backordered)
 * hold what stock allows now and leave the rest owed. This module says, before
 * the commit, what they would hold, and after it, what they did hold, on the
 * web order page and the phone order screen alike.
 *
 * ═══ THE PREVIEW IS THE FROZEN RPCs' TWIN ═══
 *
 *   approve_partial (0365):    per line, in item order, holds
 *                              least(requested, greatest(0, on_hand - every
 *                              active hold)), re-reading the holds each line.
 *   resume_fulfillment (0348): the same with owed (requested - fulfilled).
 *
 * Holds are re-read inside the loop, so an item's lines together hold exactly
 * min(Σ asked, free), and how that total is split between two lines of the
 * same item is not defined (the loop orders by item only). The preview is
 * therefore PER ITEM, never per line: duplicate lines are combined.
 *
 * ═══ THE RESULT IS READ, NEVER ECHOED ═══
 *
 * The commit is the authority (plan rule 3): it re-checks inside its own
 * transaction, and stock can move between the preview and the commit (another
 * approval, a hold, a write-off). After the commit the screen reads readiness
 * again, and the message is computed from THAT read, the order's own holds
 * (`heldOwn`), never from the preview. The preview only says how the answer
 * differs from what was shown ("2 fewer than shown because stock changed after
 * you looked").
 *
 * No new write path: the confirm calls the existing approve-partial action or
 * transition route and the resume transition, unchanged.
 *
 * Honest words (owner rules): the recorded quantity is "on record", never the
 * accounting jargon; no percentages; nothing is "guaranteed".
 */

import {
  READINESS_HOLD_STATUSES,
  READINESS_LINE_CAP,
  type OrderReadinessResult,
  type ReadinessItemAssessment,
} from './readiness';

/** Half a unit of the fourth decimal: quantities are numeric(14,4). */
const EPS = 0.00005;

function q4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function fq(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function isOne(n: number): boolean {
  return Math.abs(n - 1) < EPS;
}

function units(n: number): string {
  return isOne(n) ? 'unit' : 'units';
}

// ── The preview ─────────────────────────────────────────────────────────────

export type PartialAction = 'approve_partial' | 'resume';

/** The status each action starts from (the RPCs refuse any other). */
const FROM_STATUS: Readonly<Record<PartialAction, string>> = {
  approve_partial: 'pending_approval',
  resume: 'backordered',
};

export interface PartialPreviewItem {
  itemId: string;
  itemName: string;
  itemSku: string | null;
  /** The item's lines on the order. Duplicate lines are combined, never split. */
  lineCount: number;
  /** approve_partial: requested over the item's lines; resume: owed. */
  asked: number;
  /** What the RPC would hold now: min(asked, on hand less every active hold). */
  willHold: number;
  /** asked - willHold: owed until it arrives. */
  backorder: number;
  /** The item was deleted (approve_partial still holds its free stock). */
  deleted: boolean;
}

export type PartialPreviewUnavailable =
  /** The readiness read failed. */
  | 'read_failed'
  /** The order is not at the status the action starts from. */
  | 'wrong_status'
  /** More than 200 lines: readiness is not checked. */
  | 'lines_capped'
  /** An item the reader cannot see: its numbers are unknown. */
  | 'hidden_items'
  /** An item now belongs to another warehouse: the RPC refuses the order. */
  | 'item_moved'
  /** No lines (approve_partial refuses), or nothing owed. */
  | 'no_lines'
  /** resume only: nothing is free, so resume_fulfillment refuses. */
  | 'nothing_to_hold';

export type PartialPreview =
  | {
      state: 'ok';
      action: PartialAction;
      orderId: string;
      /** When the facts behind it were read. */
      observedAt: string;
      /** Items with something asked, in the order their first line appears. */
      items: PartialPreviewItem[];
      asked: number;
      willHold: number;
      backorder: number;
    }
  | { state: 'unavailable'; action: PartialAction; reason: PartialPreviewUnavailable; message: string };

export const PARTIAL_PREVIEW_READ_FAILED_COPY =
  "Stock couldn't be checked, so what would be held can't be shown. Try again.";
export const PARTIAL_PREVIEW_LINES_CAPPED_COPY = `This order has more than ${READINESS_LINE_CAP} lines, so what would be held isn't checked.`;
export const PARTIAL_PREVIEW_HIDDEN_ITEMS_COPY =
  "Some items on this order are not visible to you, so what would be held can't be shown.";
export const PARTIAL_PREVIEW_ITEM_MOVED_COPY =
  'An item on this order now belongs to another warehouse, so this will be refused. Remove that line first.';
export const PARTIAL_PREVIEW_NO_LINES_COPY = 'This order has nothing left to hold.';
export const PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY =
  'No stock is free for the items still owed, so Resume would hold nothing and is refused.';

function wrongStatusCopy(action: PartialAction): string {
  return action === 'approve_partial'
    ? 'This order is no longer waiting for approval.'
    : 'Only a backordered order can be resumed.';
}

function unavailable(
  action: PartialAction,
  reason: PartialPreviewUnavailable,
  message: string,
): PartialPreview {
  return { state: 'unavailable', action, reason, message };
}

/**
 * What approve partial or resume would hold now, per item, from a readiness
 * result (the one the screen shows, with its "Checked at"). Pure; the same on
 * the web and the phone. Never a guess: a failed read, a capped order, an item
 * the reader cannot see or an item that moved warehouse is `unavailable`, with
 * the reason in words.
 */
export function previewPartialFulfilment(
  result: OrderReadinessResult | null | undefined,
  action: PartialAction,
): PartialPreview {
  if (!result || result.state === 'failed') {
    return unavailable(action, 'read_failed', PARTIAL_PREVIEW_READ_FAILED_COPY);
  }
  const a = result.assessment;
  if (a.order.status !== FROM_STATUS[action] || a.phase !== 'to_pick') {
    return unavailable(action, 'wrong_status', wrongStatusCopy(action));
  }
  if (a.linesCapped) return unavailable(action, 'lines_capped', PARTIAL_PREVIEW_LINES_CAPPED_COPY);
  if (a.items.some((it) => !it.visible || !it.quantities || !it.facts)) {
    return unavailable(action, 'hidden_items', PARTIAL_PREVIEW_HIDDEN_ITEMS_COPY);
  }
  if (a.items.some((it) => it.facts?.itemWarehouseId !== a.order.warehouseId)) {
    return unavailable(action, 'item_moved', PARTIAL_PREVIEW_ITEM_MOVED_COPY);
  }

  // The lines each item's total is over (resume: only lines still owing).
  const lineCount = new Map<string, number>();
  for (const l of a.lines) {
    const lineAsked = action === 'approve_partial' ? l.requested : l.owed;
    if (lineAsked <= EPS) continue;
    lineCount.set(l.itemId, (lineCount.get(l.itemId) ?? 0) + 1);
  }

  // a.items is in the order each item's first line appears (readiness groups
  // the lines by item in line order).
  const items: PartialPreviewItem[] = [];
  for (const it of a.items as ReadinessItemAssessment[]) {
    const f = it.facts!;
    const qn = it.quantities!;
    const asked = action === 'approve_partial' ? qn.requested : qn.demand;
    if (asked <= EPS) continue;
    // Both RPCs: min(asked, max(0, on hand less every active hold)).
    const willHold = q4(Math.min(asked, qn.approveAvailable));
    items.push({
      itemId: it.itemId,
      itemName: f.name,
      itemSku: f.sku,
      lineCount: lineCount.get(it.itemId) ?? 0,
      asked: q4(asked),
      willHold,
      backorder: q4(asked - willHold),
      deleted: f.deleted,
    });
  }
  if (items.length === 0) return unavailable(action, 'no_lines', PARTIAL_PREVIEW_NO_LINES_COPY);
  const asked = q4(items.reduce((s, i) => s + i.asked, 0));
  const willHold = q4(items.reduce((s, i) => s + i.willHold, 0));
  if (action === 'resume' && willHold <= EPS) {
    return unavailable(action, 'nothing_to_hold', PARTIAL_PREVIEW_NOTHING_TO_HOLD_COPY);
  }
  return {
    state: 'ok',
    action,
    orderId: a.order.id,
    observedAt: a.observedAt,
    items,
    asked,
    willHold,
    backorder: q4(asked - willHold),
  };
}

// ── The preview, in words ───────────────────────────────────────────────────

/** Under the numbers: what happens to the rest. */
export const PARTIAL_PREVIEW_NOTE = "Picking takes what's on the shelf; the rest ships when it arrives.";

export interface PartialPreviewItemCopy {
  itemId: string;
  /** The item's name, "(2 lines)" when duplicate lines were combined. */
  label: string;
  /** "Holds 6 of 10". */
  detail: string;
  /** "Maus I, holds 6 of 10, 4 to ship when they arrive". */
  accessibilityLabel: string;
}

export interface PartialPreviewCopy {
  title: string;
  /** "Approve what's available: holds 36 of 40 units now. The other 4 ship
   *  when they arrive." */
  summary: string;
  note: string;
  items: PartialPreviewItemCopy[];
  confirmLabel: string;
  cancelLabel: string;
}

const ACTION_WORDS: Readonly<Record<PartialAction, { title: string; lead: string; confirm: string }>> = {
  approve_partial: { title: 'Approve partial', lead: "Approve what's available", confirm: 'Approve partial' },
  resume: { title: 'Resume fulfillment', lead: "Resume what's available", confirm: 'Resume fulfillment' },
};

function restSentence(backorder: number, willHold: number): string | null {
  if (backorder <= EPS) return null;
  const one = isOne(backorder);
  const verb = one ? 'ships when it arrives' : 'ship when they arrive';
  return willHold <= EPS ? `All ${fq(backorder)} ${verb}.` : `The other ${fq(backorder)} ${verb}.`;
}

/**
 * The preview's words, web and phone alike. Null for an unavailable preview
 * (its `message` is the words then).
 */
export function describePartialPreview(preview: PartialPreview): PartialPreviewCopy | null {
  if (preview.state !== 'ok') return null;
  const w = ACTION_WORDS[preview.action];
  const rest = restSentence(preview.backorder, preview.willHold);
  const summary = `${w.lead}: holds ${fq(preview.willHold)} of ${fq(preview.asked)} ${units(preview.asked)} now.${rest ? ` ${rest}` : ''}`;
  return {
    title: w.title,
    summary,
    note: PARTIAL_PREVIEW_NOTE,
    items: preview.items.map((i) => {
      const label = i.lineCount > 1 ? `${i.itemName} (${i.lineCount} lines)` : i.itemName;
      const detail = `Holds ${fq(i.willHold)} of ${fq(i.asked)}`;
      const later =
        i.backorder > EPS
          ? `, ${fq(i.backorder)} to ship when ${isOne(i.backorder) ? 'it arrives' : 'they arrive'}`
          : '';
      return {
        itemId: i.itemId,
        label,
        detail,
        accessibilityLabel: `${label}, ${detail.toLowerCase()}${later}`,
      };
    }),
    confirmLabel: w.confirm,
    cancelLabel: 'Cancel',
  };
}

// ── The result, from the re-read ────────────────────────────────────────────

export interface PartialResultCopy {
  tone: 'success' | 'warning' | 'neutral';
  text: string;
  /** Σ heldOwn over the order's items, from the re-read (null: unknown). */
  held: number | null;
  /** Σ asked over the order's items, from the re-read (null: unknown). */
  asked: number | null;
  /** preview.willHold - held: above 0 is fewer than shown (null: no
   *  preview, or unknown). */
  difference: number | null;
}

const RESULT_LEAD: Readonly<Record<PartialAction, string>> = {
  approve_partial: 'Approved.',
  resume: 'Resumed. A new pick slip is ready.',
};

function uncheckable(action: PartialAction): PartialResultCopy {
  return {
    tone: 'neutral',
    text: `${RESULT_LEAD[action]} What is held now couldn't be checked. Check again on the order.`,
    held: null,
    asked: null,
    difference: null,
  };
}

/**
 * The message after approve partial or resume, computed from `reread` (the
 * readiness read AFTER the commit), never from the preview:
 *   "Approved. Holding 36 of 40 units."
 *   "Approved. Holding 34 of 40 units, 2 fewer than shown because stock
 *    changed after you looked."
 * The preview only supplies the comparison. A re-read that failed, that is
 * about another order, or that cannot state the order's holds (past a hold
 * status, capped, an item the reader cannot see) says so: the commit
 * succeeded, but no number is claimed.
 */
export function describePartialResult(input: {
  action: PartialAction;
  preview: PartialPreview | null;
  reread: OrderReadinessResult | null | undefined;
}): PartialResultCopy {
  const { action, preview, reread } = input;
  if (!reread || reread.state !== 'ok') return uncheckable(action);
  const a = reread.assessment;
  if (a.phase !== 'to_pick' || a.linesCapped) return uncheckable(action);
  if (!(READINESS_HOLD_STATUSES as readonly string[]).includes(a.order.status)) return uncheckable(action);
  if (preview?.state === 'ok' && preview.orderId.toLowerCase() !== a.order.id.toLowerCase()) {
    return uncheckable(action);
  }
  if (a.items.length === 0 || a.items.some((it) => !it.visible || !it.facts || !it.quantities)) {
    return uncheckable(action);
  }

  let held = 0;
  let asked = 0;
  const heldByItem = new Map<string, number>();
  for (const it of a.items) {
    const h = it.facts!.heldOwn;
    held += h;
    heldByItem.set(it.itemId.toLowerCase(), h);
    asked += action === 'approve_partial' ? it.quantities!.requested : it.quantities!.demand;
  }
  held = q4(held);
  asked = q4(asked);

  const base = `${RESULT_LEAD[action]} Holding ${fq(held)} of ${fq(asked)} ${units(asked)}`;
  if (!preview || preview.state !== 'ok') {
    return { tone: 'success', text: `${base}.`, held, asked, difference: null };
  }
  const difference = q4(preview.willHold - held);
  if (difference > EPS) {
    return {
      tone: 'warning',
      text: `${base}, ${fq(difference)} fewer than shown because stock changed after you looked.`,
      held,
      asked,
      difference,
    };
  }
  if (difference < -EPS) {
    return {
      tone: 'success',
      text: `${base}, ${fq(-difference)} more than shown because stock changed after you looked.`,
      held,
      asked,
      difference,
    };
  }
  // The total matches; an item can still differ (one item got more, another
  // fewer). Say so rather than let the preview's per-item numbers stand.
  const shifted = preview.items.some(
    (i) => Math.abs((heldByItem.get(i.itemId.toLowerCase()) ?? 0) - i.willHold) > EPS,
  );
  return {
    tone: 'success',
    text: shifted
      ? `${base}. Stock changed after you looked, so some items hold a different amount than shown.`
      : `${base}.`,
    held,
    asked,
    difference,
  };
}
