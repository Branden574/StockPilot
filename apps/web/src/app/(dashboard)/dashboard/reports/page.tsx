import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  CalendarClock,
  ChevronRight,
  Clock,
  DollarSign,
  MinusCircle,
  Package,
  PackageX,
  Recycle,
  TrendingUp,
  Truck,
} from 'lucide-react';
import { redirect } from 'next/navigation';

import { BOOK_REPORT_CARD_DESCRIPTION, BOOK_REPORT_TITLE, can } from '@stockpilot/core';

import { PageHeader } from '@/components/patterns/page-header';
import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { IntentLink } from '@/components/ui/intent-link';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { reportModules, type ReportSlug } from '@/lib/reports/report-access';
import { PageTour } from '@/components/onboarding/page-tour';
import { REPORTS_TOUR } from '@/lib/onboarding/tours';

interface Report {
  slug: ReportSlug;
  name: string;
  desc: string;
  icon: typeof BarChart3;
}

const REPORTS: Report[] = [
  {
    slug: 'inventory-valuation',
    name: 'Inventory valuation',
    desc: 'Cost basis · per item, per warehouse, per category',
    icon: DollarSign,
  },
  {
    slug: 'stock-movements',
    name: 'Stock movement summary',
    desc: 'By movement type · top movers · last 30 days',
    icon: ArrowLeftRight,
  },
  {
    slug: 'reorder-forecast',
    name: 'Reorder forecast',
    desc: 'Items at or below reorder point + estimated refill cost',
    icon: AlertTriangle,
  },
  {
    slug: 'shrinkage',
    name: 'Shrinkage & adjustments',
    desc: 'Negative adjustments · cost impact · last 30 days',
    icon: MinusCircle,
  },
  {
    slug: 'supplier-scorecard',
    name: 'Supplier scorecard',
    desc: 'On-time rate · lead time · fill rate · spend · last 90 days',
    icon: Truck,
  },
  {
    slug: 'velocity-class',
    name: 'Velocity classes (ABC)',
    desc: 'Items ranked A→D by dollars-out — focus stocking + spot dead stock',
    icon: TrendingUp,
  },
  {
    slug: 'dead-stock',
    name: 'Dead stock',
    desc: 'On-hand items with no out-movement, ranked by carrying value',
    icon: Clock,
  },
  {
    slug: 'bundle-activity',
    name: 'Bundle activity',
    desc: 'Distribution runs by bundle · kits out · component cost out',
    icon: Package,
  },
  {
    slug: 'bundle-shortages',
    name: 'Bundle shortages',
    desc: 'Components that ran short during distribution, grouped by item',
    icon: PackageX,
  },
  {
    slug: 'item-cost-history',
    name: 'Item cost history',
    desc: 'Unit cost over time by supplier — from PO + receipt history',
    icon: TrendingUp,
  },
];

export default async function ReportsPage() {
  // Explicit page gate to match the sidebar placement (requires
  // reports:read) — previously nav-only, so any member could load the
  // hub via direct URL. Viewer gains it only via an explicit grant.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'reports:read')) {
    redirect('/dashboard');
  }
  // Each card is listed only where every module its report reads is on
  // (lib/reports/report-access): the same list the report's page and its
  // data path check again.
  const optional = ['lot_serial', 'orders', 'books', 'bundles', 'purchase_orders'] as const;
  const access = await Promise.all(optional.map((m) => checkModuleAccess(m)));
  const enabled = new Set<string>(optional.filter((_, i) => access[i]!.enabled));
  const all: Report[] = [
    ...REPORTS,
    {
      slug: 'book-order-totals',
      name: BOOK_REPORT_TITLE,
      desc: BOOK_REPORT_CARD_DESCRIPTION,
      icon: BookOpen,
    },
    {
      slug: 'lot-expiry',
      name: 'Aging & expiry',
      desc: 'Lots by days-to-expiry · near-expiry & expired flagged',
      icon: CalendarClock,
    },
    {
      slug: 'lot-trace',
      name: 'Recall / lot trace',
      desc: 'Trace a lot number across receipts + picks',
      icon: Recycle,
    },
  ];
  const reports = all.filter((r) => reportModules(r.slug).every((m) => enabled.has(m)));

  return (
    <div className={REPORT_PAGE_CLASS}>
      <PageHeader
        title="Reports"
        subline={<>{reports.length} pre-baked reports.</>}
        tour={<PageTour tour={REPORTS_TOUR} />}
        actions={<PdfDownloadDropdown baseUrl="/api/reports/inventory-snapshot/pdf" />}
      />

      {/* One tile per report, each to its own route. IntentLink, not Link: a
          page of tiles that prefetch on sight was 26 requests for 13 tiles
          (components/ui/intent-link.tsx); a tile is warmed when someone
          reaches for it instead. The REPORTS_TOUR's second step targets
          `main a[href^="/dashboard/reports/"]`, which these stay. */}
      <ul role="list" className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {reports.map((r) => (
          <li key={r.slug} className="min-w-0">
            <IntentLink
              href={`/dashboard/reports/${r.slug}`}
              className="border-border bg-card hover:bg-muted group flex h-full min-w-0 items-start gap-3 rounded-lg border px-[18px] py-4 transition-colors hover:border-[var(--ed-line-strong)]"
            >
              <span
                aria-hidden
                className="border-border bg-sunk text-ink-2 flex size-8 shrink-0 items-center justify-center rounded-md border"
              >
                <r.icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-foreground text-[13.5px] font-medium leading-5">
                    {r.name}
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="text-muted-foreground h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </span>
                <span className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18.75px]">
                  {r.desc}
                </span>
              </span>
            </IntentLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The report pages' frame: the redesign's list-page gutters and width. */
const REPORT_PAGE_CLASS =
  'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';
