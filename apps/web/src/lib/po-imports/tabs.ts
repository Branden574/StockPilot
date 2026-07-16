import type { PoImportStatus } from '@stockpilot/core';

// ── Status grouping ────────────────────────────────────────────────────────
// po_imports has 8 statuses (uploaded/parsing/parsed/needs_review/approved/
// failed/duplicate/canceled — one 'l', see poImportStatusSchema); we
// partition them into mutually-exclusive filter tabs (every status lands in
// exactly one tab — asserted in tabs.test.ts) mirroring the purchase-orders
// page's TAB_STATUSES pattern (lib/purchase-orders/tabs.ts).
//
//   Active    — the working set: still uploading/parsing/under review, PLUS
//               failed/duplicate. Those two stay in Active (not banished to
//               their own tab) so a user can see and retry/resolve them
//               instead of losing them outside the queue they're used to.
//   Approved  — converted into a real purchase order.
//   Cancelled — voided before approval — largely test/mistake noise. Giving
//               it its own tab (default OFF) is what unmixes it from the
//               working set (owner request 2026-07-16).
export type PoImportTab = 'active' | 'approved' | 'cancelled';

export const TAB_ORDER: PoImportTab[] = ['active', 'approved', 'cancelled'];

export const TAB_LABELS: Record<PoImportTab, string> = {
  active: 'Active',
  approved: 'Approved',
  cancelled: 'Cancelled',
};

export const TAB_STATUSES: Record<PoImportTab, PoImportStatus[]> = {
  active: ['uploaded', 'parsing', 'parsed', 'needs_review', 'failed', 'duplicate'],
  approved: ['approved'],
  cancelled: ['canceled'],
};

/** Default tab for the imports index — Active, so cancelled/approved runs
 *  (especially test uploads) don't sit mixed in with the working queue. */
export const DEFAULT_TAB: PoImportTab = 'active';

export function isImportTab(value: string | undefined): value is PoImportTab {
  return TAB_ORDER.includes(value as PoImportTab);
}
