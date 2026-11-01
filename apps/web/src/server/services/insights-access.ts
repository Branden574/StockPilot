import { can } from '@stockpilot/core';

import { canOpenCountPage } from '@/lib/verification/count-page-access';

import { isModuleEnabled, type ServiceContext } from './context';

/**
 * Who may read each line of the briefing (Today's briefing, the morning
 * briefing notice). Docket S36, part a, with B72 part 3: every line used to
 * go to anyone who could open the briefing (items:update), so a staff member
 * without orders:approve read "N orders awaiting approval" for the whole
 * organization and its link opened their own requests. Each line now follows
 * the gate of the page it links to, so a reader is told only what they can
 * open and act on.
 *
 * Kept apart from insights.ts on purpose: the daily briefing's route test
 * mocks that module with its two exports only.
 */

/** Every line the briefing can hold. */
export const INSIGHT_SIGNAL_KEYS = [
  'pending_approvals',
  'overdue_pos',
  'low_stock',
  'open_cycle_counts',
  'open_pos',
] as const;

export type InsightSignalKey = (typeof INSIGHT_SIGNAL_KEYS)[number];

/** The reader: their role, their effective permission set (a context with no
 *  set, the cron's owner context, falls back to the role's defaults in
 *  can()), and the organization's modules. */
export type InsightReader = Pick<ServiceContext, 'role' | 'permissions' | 'enabledModules'>;

/** One rule per line; the Record type makes tsc ask for a rule for every key. */
export const INSIGHT_SIGNAL_ACCESS: Record<InsightSignalKey, (reader: InsightReader) => boolean> = {
  // The Overview's approver rule (dashboard/page.tsx approvesOrders): approving
  // follows orders:approve alone, an override winning either way, and the app
  // refuses a viewer every write. Its link opens the Orders list.
  pending_approvals: (r) =>
    isModuleEnabled(r, 'orders') && can(r, 'orders:approve') && r.role !== 'viewer',
  // The purchase orders page: the module, and purchase_orders:read.
  overdue_pos: (r) => isModuleEnabled(r, 'purchase_orders') && can(r, 'purchase_orders:read'),
  open_pos: (r) => isModuleEnabled(r, 'purchase_orders') && can(r, 'purchase_orders:read'),
  // The Items page has no permission gate of its own; items:read is what the
  // key means.
  low_stock: (r) => can(r, 'items:read'),
  // The count pages' gate: cycle_counts:read or stock:adjust.
  open_cycle_counts: (r) => isModuleEnabled(r, 'cycle_counts') && canOpenCountPage(r),
};

/**
 * The lines this reader may read, in order, and the low-stock examples only
 * with the low-stock line (the AI summary quotes them). A line with no rule is
 * dropped: never shown by default.
 */
export function insightsVisibleTo<S extends { key: InsightSignalKey }, L>(
  result: { signals: S[]; lowStock: L[] },
  reader: InsightReader,
): { signals: S[]; lowStock: L[] } {
  // Looked up as a partial map: a key from outside the type (an older payload,
  // a test double) finds no rule and is dropped.
  const rules: Partial<Record<string, (reader: InsightReader) => boolean>> = INSIGHT_SIGNAL_ACCESS;
  return {
    signals: result.signals.filter((s) => rules[s.key]?.(reader) === true),
    lowStock: INSIGHT_SIGNAL_ACCESS.low_stock(reader) ? result.lowStock : [],
  };
}
