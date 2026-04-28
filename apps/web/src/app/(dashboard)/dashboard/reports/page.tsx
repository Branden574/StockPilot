import { BarChart3, ChevronRight, Download, Plus } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { requireOrgContext } from '@/lib/auth/session';

interface Report {
  slug: string;
  name: string;
  desc: string;
  updated: string;
}

const REPORTS: Report[] = [
  {
    slug: 'inventory-valuation',
    name: 'Inventory valuation',
    desc: 'Cost basis · all locations · point-in-time',
    updated: 'Hourly',
  },
  {
    slug: 'stock-movement-summary',
    name: 'Stock movement summary',
    desc: 'By type · by user · by location',
    updated: 'Daily',
  },
  {
    slug: 'reorder-forecast',
    name: 'Reorder forecast',
    desc: 'Items below reorder point + projected stockouts',
    updated: 'Hourly',
  },
  {
    slug: 'margin-by-sku',
    name: 'Margin by SKU',
    desc: 'Sell price − cost · sorted by contribution',
    updated: 'Daily',
  },
  {
    slug: 'shrinkage-adjustments',
    name: 'Shrinkage & adjustments',
    desc: 'All negative adjustments · with reason codes',
    updated: 'Daily',
  },
  {
    slug: 'supplier-scorecard',
    name: 'Supplier scorecard',
    desc: 'On-time rate · price drift · lead-time variance',
    updated: 'Weekly',
  },
];

export default async function ReportsPage() {
  await requireOrgContext();

  return (
    <div className="mx-auto w-full max-w-[1480px] px-8 pb-20 pt-7">
      <div className="mb-5 flex items-end justify-between gap-6 border-b border-border pb-4">
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
            Inventory
          </p>
          <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">Reports</h1>
          <p className="mt-1 text-[13.5px] text-[var(--ed-ink-3)]">
            {REPORTS.length} saved reports — exportable to CSV.
          </p>
        </div>
        <Button size="sm" disabled title="Custom reports coming in Phase 9">
          <Plus className="h-3 w-3" /> New report
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {REPORTS.map((r) => (
          <article
            key={r.slug}
            className="rounded-[10px] border border-border bg-card p-5 transition-colors hover:border-[var(--ed-line-strong)]"
          >
            <div className="flex items-center gap-2.5">
              <BarChart3 className="h-4 w-4 text-foreground" strokeWidth={1.5} />
              <div className="font-display text-[14px] font-medium tracking-[-0.01em]">{r.name}</div>
            </div>
            <p className="mt-1.5 text-[12.5px] text-[var(--ed-ink-3)]">{r.desc}</p>

            <hr className="my-3.5 border-border" />

            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-[var(--ed-ink-4)]">Updated {r.updated}</span>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" disabled className="h-7 gap-1 px-2">
                  <Download className="h-3 w-3" /> CSV
                </Button>
                <Button asChild variant="outline" size="sm" className="h-7 gap-1 px-2">
                  <Link href="/dashboard/inventory">
                    Open <ChevronRight className="h-3 w-3" />
                  </Link>
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>

      <p className="mt-8 text-[12px] text-[var(--ed-ink-4)]">
        Custom report builder lands in Phase 9 with the AI assistant. For now these are pre-baked queries
        you can export.
      </p>
    </div>
  );
}
