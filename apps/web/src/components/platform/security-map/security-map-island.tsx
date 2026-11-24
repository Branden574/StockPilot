'use client';

import dynamic from 'next/dynamic';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

import type { SecurityMapClientProps } from './security-map-client';

// LAZY CLIENT ISLAND, as components/dashboard/charts/cost-trend-island.tsx
// does it: the attack map's client code is loaded after the page is drawn,
// only in the browser (ssr: false), and never in any other page's bundle.
// The globe's renderer, the one module that loads three.js, is loaded later
// still, by security-map-globe.tsx, and only when the globe is shown.
const SecurityMapClient = dynamic(
  () => import('./security-map-client').then((m) => m.SecurityMapClient),
  { ssr: false, loading: () => <SecurityMapLoading /> },
);

/**
 * Client entry point for the attack map. Safe to render from a Server
 * Component: `next/dynamic(..., { ssr: false })` must live in a client
 * module, which this is. `initial` is the section's first read of the whole
 * window; the island reads it again before trusting it.
 */
export function SecurityMapIsland(props: SecurityMapClientProps) {
  return <SecurityMapClient {...props} />;
}

function SecurityMapLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-muted h-[86px] w-full animate-pulse rounded-lg" />
      <div className="bg-muted flex h-[clamp(300px,52vw,600px)] w-full items-center justify-center rounded-lg">
        <p className="text-muted-foreground text-[13px]">{SECURITY_MAP_WORDS.loading}</p>
      </div>
    </div>
  );
}
