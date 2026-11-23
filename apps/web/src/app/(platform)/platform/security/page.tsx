import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import { PlatformPage } from '@/components/platform/platform-page';
import { PlatformPasskeysSection } from '@/components/platform/platform-passkeys-section';
import { PlatformTable } from '@/components/platform/platform-table';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { requirePlatformAdmin } from '@/lib/auth/platform-admin';
import { formatExactUtc } from '@/lib/platform/last-active';
import {
  listPlatformSecurityEvents,
  PLATFORM_SECURITY_EVENT_LIMIT,
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
 * layout renders in parallel and cannot stop this body's read).
 *
 * Above the events, PASSKEYS (plan section 4): the kill switch, new passkeys
 * and the organizations with passkeys on (components/platform/
 * platform-passkeys-section.tsx; its presses are the actions in
 * server/actions/platform/passkeys.ts, each re-gated with a fresh step-up).
 * First on the page, so in an incident the kill switch is never below the
 * events list.
 */
export default async function PlatformSecurityEventsPage() {
  await requirePlatformAdmin();

  const rows = await listPlatformSecurityEvents({ limit: PLATFORM_SECURITY_EVENT_LIMIT });

  return (
    <PlatformPage>
      <PageHeader
        title="Security events"
        subline={`What the app refused, across every organization and none. The newest ${PLATFORM_SECURITY_EVENT_LIMIT} entries; each counts events of one kind in one minute.`}
      />

      {/* The passkey switches (part 2, stage 6): read with the service
          client, after the gate above, like the events. */}
      <PlatformPasskeysSection />

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
                    {securityEventCategoryLabel(r.category)} ·{' '}
                    {securityEventOutcomeLabel(r.outcome)}
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
    </PlatformPage>
  );
}
