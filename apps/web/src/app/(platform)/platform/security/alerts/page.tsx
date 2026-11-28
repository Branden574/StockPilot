import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformSecurityAlertsSection } from '@/components/platform/platform-security-alerts-section';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';

import { SECURITY_ALERTS_WORDS } from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css), then the console's own frame (pages/platform.css): every
// rule is scoped to this area's [data-glass-page] root and to glass, so Classic
// never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';
import '@/styles/liquid-glass/pages/platform.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Security alerts · Platform' };

/**
 * THE SECURITY ALERTS (part 5, stage 4a: RECORD ONLY): what the alert job
 * found each time it checked the security record, what it recorded, what
 * each alert would have done with a channel on, the job's own heartbeat, the
 * thresholds in force (read only) and who changed what. Nothing is sent in
 * this release, and the page says so first.
 *
 * The gate is here, first: requirePlatformAdmin() before anything is read,
 * exactly as the attack map's page. The section reads once, inside
 * <Suspense>, so the header never waits for it; "Check again" asks
 * readPlatformSecurityAlertsAction, which asks the console's own rule again
 * (checkPlatformConsoleRead).
 *
 * In the Liquid Glass console frame, as the other console pages (the owner's
 * word, 2026-11-28): glass-scope.guard.test.ts lists it.
 */
export default async function PlatformSecurityAlertsPage() {
  await requirePlatformAdmin();

  return (
    <PlatformPage>
      <PageHeader
        title={SECURITY_ALERTS_WORDS.title}
        subline={SECURITY_ALERTS_WORDS.subline}
        back={
          <PageHeaderBackLink href="/platform/security">
            {SECURITY_ALERTS_WORDS.back}
          </PageHeaderBackLink>
        }
      />
      <Suspense
        fallback={
          <p role="status" className="text-muted-foreground text-[13px]">
            {SECURITY_ALERTS_WORDS.loading}
          </p>
        }
      >
        <PlatformSecurityAlertsSection />
      </Suspense>
    </PlatformPage>
  );
}
