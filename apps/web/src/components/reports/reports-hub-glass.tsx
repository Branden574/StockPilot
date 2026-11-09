import {
  AlertTriangle,
  Archive,
  ArrowLeftRight,
  BarChart3,
  Calendar,
  CalendarDays,
  ChevronRight,
  History,
  List,
  type LucideIcon,
  Package,
  RefreshCw,
  Repeat,
  School,
  SlidersHorizontal,
  TrendingUp,
  Truck,
} from 'lucide-react';

import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { IntentLink } from '@/components/ui/intent-link';
import type { ReportSlug } from '@/lib/reports/report-access';

/** One report the hub lists: the same object the Classic tiles are drawn from. */
export interface HubReport {
  slug: ReportSlug;
  name: string;
  desc: string;
}

/**
 * Reports.dc.html's groups, in the board's order. Every report slug is in
 * exactly one group or is the feature tile (Book Order Totals), so the
 * glass hub lists exactly the reports the Classic list does
 * (reports-hub-glass.test.tsx).
 */
export const HUB_GROUPS: ReadonlyArray<{ name: string; slugs: readonly ReportSlug[] }> = [
  {
    name: 'Inventory',
    slugs: ['inventory-valuation', 'stock-movements', 'shrinkage', 'velocity-class', 'dead-stock'],
  },
  {
    name: 'Purchasing & cost',
    slugs: ['reorder-forecast', 'supplier-scorecard', 'item-cost-history'],
  },
  { name: 'Bundles', slugs: ['bundle-activity', 'bundle-shortages'] },
  { name: 'Lots', slugs: ['lot-expiry', 'lot-trace'] },
];

/** The feature tile's report (Reports.dc.html .feature-tile). */
export const HUB_FEATURE: ReportSlug = 'book-order-totals';

/** The board's tile icons (Reports.dc.html R(name, desc, icon)), Lucide at the glass stroke. */
const ICONS: Partial<Record<ReportSlug, LucideIcon>> = {
  'inventory-valuation': BarChart3,
  'stock-movements': ArrowLeftRight,
  shrinkage: TrendingUp,
  'velocity-class': SlidersHorizontal,
  'dead-stock': Archive,
  'reorder-forecast': RefreshCw,
  'supplier-scorecard': Truck,
  'item-cost-history': History,
  'bundle-activity': Package,
  'bundle-shortages': AlertTriangle,
  'lot-expiry': Calendar,
  'lot-trace': Repeat,
};

/**
 * THE REPORTS HUB IN LIQUID GLASS (Reports.dc.html, stage 4 insights lane):
 * the Book Order Totals feature tile, then the reports in the board's four
 * groups (Inventory, Purchasing & cost, Bundles, Lots), each an eyebrow
 * heading over a grid of tiles.
 *
 * Glass-only (plan 4.4, 4.6): Classic's flat list cannot be regrouped by CSS
 * without moving its links out of their reading order (WCAG 2.4.3), so glass
 * draws this block in its place and Classic's tiles carry
 * data-classic-only. Each link here goes where one Classic tile goes, with
 * the same words, from the same list (the page's module-filtered `reports`):
 * no report appears that Classic does not show, and none is lost. It holds
 * links only (no state), is hidden in Classic by visibility.css, and is not
 * rendered at all under the `off` rollout. Allowlisted as
 * "reports-hub-glass" (tests/e2e/appearance/glass-only-allowlist.json).
 *
 * Decoration only, aria-hidden: the feature tile's eyebrow, its three chips
 * (the report's own filters and drawer, as the board names them) and the
 * cover fan, drawn as three tinted book shapes because the hub loads no
 * book covers (plan 4.6 data rule). So each link's accessible name is the
 * Classic tile's: the report's name and its description.
 */
export function ReportsHubGlass({ reports }: { reports: readonly HubReport[] }) {
  if (liquidGlassRollout() === 'off') return null;
  const bySlug = new Map(reports.map((r) => [r.slug, r]));
  const feature = bySlug.get(HUB_FEATURE);
  const groups = HUB_GROUPS.map((g) => ({
    name: g.name,
    items: g.slugs.flatMap((slug) => {
      const r = bySlug.get(slug);
      return r ? [r] : [];
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <section data-glass-only="" data-glass="reports-hub">
      {feature ? (
        <IntentLink href={`/dashboard/reports/${feature.slug}`} data-glass="reports-feature">
          <span data-glass="reports-feature-text">
            <span aria-hidden="true" data-glass="reports-feature-eyebrow">
              Orders &amp; books
            </span>
            <span data-glass="reports-feature-title">{feature.name}</span>
            <span data-glass="reports-feature-desc">{feature.desc}</span>
            <span aria-hidden="true" data-glass="reports-feature-chips">
              <span data-glass="reports-feature-chip">
                <School strokeWidth={1.8} />
                By charter
              </span>
              <span data-glass="reports-feature-chip">
                <CalendarDays strokeWidth={1.8} />
                Exact From / To
              </span>
              <span data-glass="reports-feature-chip">
                <List strokeWidth={1.8} />
                Orders behind each total
              </span>
            </span>
          </span>
          <span aria-hidden="true" data-glass="reports-cover-fan">
            <span />
            <span />
            <span />
          </span>
          <ChevronRight aria-hidden="true" data-glass="reports-feature-chevron" strokeWidth={1.8} />
        </IntentLink>
      ) : null}
      {groups.map((g) => {
        const headingId = `reports-group-${g.name.toLowerCase().replace(/[^a-z]+/gu, '-')}`;
        return (
          <section key={g.name} aria-labelledby={headingId} data-glass="reports-group">
            <h2 id={headingId} data-glass="reports-group-title">
              {g.name}
            </h2>
            <ul role="list" data-glass="reports-grid">
              {g.items.map((r) => {
                const Icon = ICONS[r.slug] ?? BarChart3;
                return (
                  <li key={r.slug}>
                    <IntentLink href={`/dashboard/reports/${r.slug}`} data-glass="report-tile">
                      <span aria-hidden="true" data-glass="report-tile-icon">
                        <Icon strokeWidth={1.8} />
                      </span>
                      <span data-glass="report-tile-text">
                        <span data-glass="report-tile-name">{r.name}</span>
                        <span data-glass="report-tile-desc">{r.desc}</span>
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        data-glass="report-tile-chevron"
                        strokeWidth={1.8}
                      />
                    </IntentLink>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
