'use client';

import dynamic from 'next/dynamic';

import type { CostTrendWidgetProps } from './cost-trend-widget';

// LAZY CLIENT ISLAND. Recharts is heavy and client-only, so the cost-trend
// widget is deferred behind a dynamic import with ssr:false — exactly the
// pattern T1 established for the dashboard analytics grid. The item-detail
// server shell + tabs paint first; this chart hydrates AFTER, with the
// skeleton holding the layout so nothing jumps. The server never imports
// Recharts on the item-detail path.
const CostTrendWidget = dynamic(
  () => import('./cost-trend-widget').then((m) => m.CostTrendWidget),
  {
    ssr: false,
    loading: () => <CostTrendSkeleton />,
  },
);

/**
 * Client entry point for the item-detail cost-trend chart. Safe to import
 * from a Server Component — `next/dynamic(..., { ssr:false })` must live in a
 * client module, which this is. Pass it the pre-fetched, JSON-serializable
 * `series` computed on the server by ReportsService.itemCostHistory.
 */
export function CostTrendIsland(props: CostTrendWidgetProps) {
  return <CostTrendWidget {...props} />;
}

function CostTrendSkeleton() {
  return <div className="bg-muted/40 h-[240px] w-full animate-pulse rounded-md" />;
}
