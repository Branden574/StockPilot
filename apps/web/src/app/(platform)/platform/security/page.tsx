import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformPasskeysSection } from '@/components/platform/platform-passkeys-section';
import { PlatformSecurityBriefingSection } from '@/components/platform/platform-security-briefing-section';
import { PlatformTable } from '@/components/platform/platform-table';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { isNextControlFlowError, reportError } from '@/lib/error-reporter';
import { formatExactUtc } from '@/lib/platform/last-active';
import { notFoundUnlessUuid } from '@/server/lib/path-id';
import {
  listPlatformSecurityEvents,
  PLATFORM_SECURITY_EVENT_LIMIT,
  type PlatformSecurityEventRow,
} from '@/server/services/platform/security-events';

import {
  securityEventCategoryLabel,
  securityEventOutcomeLabel,
  securityEventPlaceLabel,
  securityEventReasonLabel,
  securityEventSourceLabel,
} from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css), then the console's own frame (pages/platform.css): every
// rule is scoped to this area's [data-glass-page] root and to glass, so Classic
// never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';
import '@/styles/liquid-glass/pages/platform.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Security events · Platform' };

/** Rows that count events past a cap: they have a count and no place. */
const OVER_CAP = new Set(['over_minute_cap', 'over_buffer_cap']);

/**
 * SECURITY EVENTS across the platform: the newest rows of every organization
 * and the rows with no organization, with the organization's name. Read with
 * the service client (server/services/platform/security-events.ts), so the
 * gate is here, first: requirePlatformAdmin() before anything is read (the
 * layout renders in parallel and cannot stop this body's read). The list is
 * the last part of the page and is read in its own <Suspense> (the function
 * below this one), after the gate has answered: nothing above it waits for
 * it, and when its read fails it shows a notice in the table's place. Until
 * 2026-11-23 the page body awaited that read before it returned anything, so
 * a slow or unreadable events table held the passkey switches back and then
 * answered "Something went wrong" for the whole page.
 *
 * Above the events, PASSKEYS (plan section 4): the kill switch, new passkeys
 * and the organizations with passkeys on (components/platform/
 * platform-passkeys-section.tsx; its presses are the actions in
 * server/actions/platform/passkeys.ts, each re-gated with a fresh step-up).
 * First on the page, so in an incident the kill switch is never below the
 * events list.
 *
 * Between the two, THE SECURITY BRIEFING (components/platform/
 * platform-security-briefing-section.tsx): this week across every
 * organization in counts, and one organization's briefing with ?org=<uuid>.
 * It is after the Passkeys section and inside <Suspense>, so a slow or
 * failed briefing never delays the passkey switches. An ?org= value that is
 * not a uuid is Page not found here, before anything is read with it.
 */
export default async function PlatformSecurityEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string | string[] }>;
}) {
  const admin = await requirePlatformAdmin();

  // A repeated ?org= arrives as a list: the first one is the one read.
  const { org: orgParam } = await searchParams;
  const org = (Array.isArray(orgParam) ? orgParam[0] : orgParam) ?? null;
  if (org !== null) notFoundUnlessUuid(org);

  return (
    <PlatformPage>
      <PageHeader
        title="Security events"
        subline={`What the app refused, across every organization and none. The newest ${PLATFORM_SECURITY_EVENT_LIMIT} entries; each counts events of one kind in one minute.`}
        actions={
          <Link
            href="/platform/security/map"
            // Never prefetched: opening the map reads the whole window.
            prefetch={false}
            className="text-ink-2 hover:text-foreground text-[13px] underline underline-offset-2"
          >
            Attack map
          </Link>
        }
      />

      {/* The passkey switches (part 2, stage 6): read with the service
          client, after the gate above, like the events. */}
      <PlatformPasskeysSection />

      {/* The briefing: after the passkey switches, and streamed in on its
          own, so the switches never wait for it. */}
      <Suspense
        fallback={
          <p className="text-muted-foreground text-[13px]">Checking this week&apos;s summary...</p>
        }
      >
        <PlatformSecurityBriefingSection
          organizationId={org}
          actor={{ userId: admin.userId, email: admin.email }}
        />
      </Suspense>

      {/* The events list: last, and streamed in on its own too, so the
          switches and the briefing never wait for it. */}
      <Suspense
        fallback={<p className="text-muted-foreground text-[13px]">Loading security events...</p>}
      >
        <PlatformSecurityEventsList />
      </Suspense>
    </PlatformPage>
  );
}

/**
 * The events list, read here and nowhere above: rendered only as part of the
 * tree the gated page body returns, so the gate has answered before this
 * runs. The try/catch is around the one read and nothing else. A read that
 * fails is one warning (the tag and the error's own words, which carry the
 * database's code and no row) and a notice where the table would be; it
 * never takes the passkey switches or the briefing down with it.
 */
async function PlatformSecurityEventsList() {
  let rows: PlatformSecurityEventRow[];
  try {
    rows = await listPlatformSecurityEvents({ limit: PLATFORM_SECURITY_EVENT_LIMIT });
  } catch (err) {
    // Next's own signals (a redirect, Page not found) are never a failed read.
    if (isNextControlFlowError(err)) throw err;
    void reportError(err, {
      tag: 'platform.security-events.list',
      level: 'warning',
    });
    return (
      <p className="text-muted-foreground text-[13px]">
        Security events could not be loaded just now. Refresh to try again.
      </p>
    );
  }

  return (
    <PlatformTable label="Security events" minWidth={980}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead title="In UTC.">When</TableHead>
          <TableHead>What</TableHead>
          <TableHead>Organization</TableHead>
          <TableHead>Where</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Count</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={6} className="p-0">
              <StatePanel
                kind="empty"
                surface="plain"
                headingLevel={null}
                icon={null}
                title="No security events recorded yet."
              />
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                {formatExactUtc(r.lastSeenAt) ?? '—'}
              </TableCell>
              <TableCell>
                <span className="text-foreground">{securityEventReasonLabel(r.reason)}</span>
                <span className="text-muted-foreground block text-[12px]">
                  {securityEventCategoryLabel(r.category)} · {securityEventOutcomeLabel(r.outcome)}
                </span>
              </TableCell>
              <TableCell>
                {r.organizationId === null ? (
                  <span className="text-muted-foreground">No organization</span>
                ) : (
                  <Link
                    href={`/platform/orgs/${r.organizationId}`}
                    // Never prefetched: rendering an organization's page
                    // writes a viewed_org row to the audit trail.
                    prefetch={false}
                    className={
                      r.organizationName
                        ? 'text-ink-2 hover:text-foreground'
                        : 'text-muted-foreground hover:text-foreground font-mono text-[12px]'
                    }
                  >
                    {r.organizationName ?? r.organizationId}
                  </Link>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {OVER_CAP.has(r.reason) ? '—' : securityEventPlaceLabel(r.country, r.city)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {securityEventSourceLabel(r.source)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {r.count.toLocaleString('en-US')}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </PlatformTable>
  );
}
