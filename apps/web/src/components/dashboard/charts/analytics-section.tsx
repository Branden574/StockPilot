'use client';

import dynamic from 'next/dynamic';

import type { AnalyticsGridProps } from './analytics-grid';

// LAZY CLIENT ISLAND. Recharts is heavy and client-only, so we defer the
// whole analytics grid behind a dynamic import with ssr:false. The dashboard
// shell + streamed table paint first (server-rendered); these charts hydrate
// AFTER, with the skeleton holding the layout so nothing jumps. This keeps
// the recently-optimized Suspense-streamed dashboard load off the Recharts
// critical path — the server never imports Recharts.
const AnalyticsGrid = dynamic(
  () => import('./analytics-grid').then((m) => m.AnalyticsGrid),
  {
    ssr: false,
    loading: () => <AnalyticsSkeleton />,
  },
);

/**
 * Client entry point for the dashboard Analytics section. Receives
 * already-mapped, JSON-serializable widget data (computed on the server) and
 * renders the lazily-loaded chart grid. Importing this from a Server
 * Component is safe — `next/dynamic(..., { ssr:false })` must live in a
 * client module, which this is.
 */
export function AnalyticsSection(props: AnalyticsGridProps) {
  return <AnalyticsGrid {...props} />;
}

function AnalyticsSkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-1 gap-3.5 lg:grid-cols-12">
      <div className="bg-card border-border h-[360px] rounded-lg border lg:col-span-8" />
      <div className="bg-card border-border h-[360px] rounded-lg border lg:col-span-4" />
      <div className="bg-card border-border h-[300px] rounded-lg border lg:col-span-12" />
    </div>
  );
}
