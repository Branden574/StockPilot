import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformSecurityMapSection } from '@/components/platform/platform-security-map-section';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css), then the console's own frame (pages/platform.css): every
// rule is scoped to this area's [data-glass-page] root and to glass, so Classic
// never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';
import '@/styles/liquid-glass/pages/platform.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Attack map · Platform' };

/**
 * THE ATTACK MAP: what the app blocked and flagged across every organization
 * and none, by the country it came from, drawn on a globe (or a flat map) and
 * listed in full in a table under it. The gate is here, first:
 * requirePlatformAdmin() before anything is read. The map's section reads the
 * whole window once, inside <Suspense>, so the header never waits for it;
 * after that the open page polls pollPlatformSecurityMapAction, which asks
 * the console's own rule again on every read (checkPlatformConsoleRead).
 */
export default async function PlatformSecurityMapPage() {
  await requirePlatformAdmin();

  return (
    <PlatformPage>
      <PageHeader
        title={SECURITY_MAP_WORDS.title}
        subline="What the app blocked and flagged, across every organization and none, by the country it came from."
        back={<PageHeaderBackLink href="/platform/security">← Security</PageHeaderBackLink>}
      />
      <Suspense
        fallback={<p className="text-muted-foreground text-[13px]">{SECURITY_MAP_WORDS.loading}</p>}
      >
        <PlatformSecurityMapSection />
      </Suspense>
    </PlatformPage>
  );
}
