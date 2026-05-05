import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  ChevronRight,
  DollarSign,
  MinusCircle,
  Truck,
} from 'lucide-react';
import Link from 'next/link';

import { requireOrgContext } from '@/lib/auth/session';

interface Report {
  slug: string;
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
];

export default async function ReportsPage() {
  await requireOrgContext();

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="border-border mb-6 flex items-end justify-between gap-6 border-b pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {REPORTS.length} pre-baked reports — every one is exportable to CSV.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {REPORTS.map((r) => (
          <Link
            key={r.slug}
            href={`/dashboard/reports/${r.slug}`}
            className="border-border bg-card hover:border-foreground/30 group flex items-start gap-3 rounded-lg border p-4 transition-colors"
          >
            <div className="bg-muted rounded-md p-2">
              <r.icon className="h-4 w-4" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <div className="font-medium">{r.name}</div>
                <ChevronRight className="text-muted-foreground h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <p className="text-muted-foreground mt-1 text-xs">{r.desc}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
