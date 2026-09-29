import type { ModuleId } from '@stockpilot/core';

/**
 * Every report the web app serves, by its URL slug, and the modules each one
 * reads beyond the always-on core (inventory, movements, reports).
 *
 * ONE list for every check, so the hub card, the page, the service and the
 * export routes can never disagree about what a report needs:
 *   - the hub shows a card only when its modules are on;
 *   - the page checks reports:read and these modules itself (a layout's check
 *     does not stop its page from rendering);
 *   - ReportsService.gate(slug) checks reports:read (MFA step-up first) and
 *     these modules before any read, for the page, the CSV, the PDF and the
 *     XLSX alike.
 * Book Order Totals keeps its own gate (BookOrderTotalsService.gate) and is
 * listed for completeness.
 */
export const REPORT_MODULES = {
  'inventory-valuation': [],
  'stock-movements': [],
  'reorder-forecast': [],
  shrinkage: [],
  'supplier-scorecard': ['purchase_orders'],
  'velocity-class': [],
  'dead-stock': [],
  'bundle-activity': ['bundles'],
  'bundle-shortages': ['bundles'],
  'item-cost-history': ['purchase_orders'],
  'lot-expiry': ['lot_serial'],
  'lot-trace': ['lot_serial'],
  'book-order-totals': ['orders', 'books'],
} as const satisfies Record<string, readonly ModuleId[]>;

export type ReportSlug = keyof typeof REPORT_MODULES;

export function isReportSlug(value: string): value is ReportSlug {
  return Object.prototype.hasOwnProperty.call(REPORT_MODULES, value);
}

/** The modules a report reads beyond the core. */
export function reportModules(report: ReportSlug): readonly ModuleId[] {
  return REPORT_MODULES[report];
}
