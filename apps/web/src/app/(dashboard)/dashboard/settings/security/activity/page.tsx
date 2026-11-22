import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AuditTime } from '@/components/admin/audit-time';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AUTHENTICATOR_SET_UP_URL } from '@/lib/auth/authenticator-set-up';
import { ServiceError, withContext } from '@/server/services/context';
import {
  assertMaySeeSecurityActivity,
  SECURITY_ACTIVITY_ROW_LIMIT,
  SECURITY_ACTIVITY_TOTALS_DAYS,
  SecurityEventsService,
  type SecurityActivity,
} from '@/server/services/security-events';

import {
  securityEventCategoryLabel,
  securityEventOutcomeLabel,
  securityEventPlaceLabel,
  securityEventReasonLabel,
  securityEventSourceLabel,
} from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css): every rule is scoped to this area's [data-glass-page] root
// and to glass, so Classic never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Blocked activity — Settings' };

/** Rows that count events past a cap: they have a count and no place. */
const OVER_CAP = new Set(['over_minute_cap', 'over_buffer_cap']);

const THIS_PAGE = '/dashboard/settings/security/activity';

/**
 * A refusal, turned into where the member is sent: to set-up when an
 * authenticator is owed, to the code page when this session has not given
 * its code, otherwise to `elsewhere`. Anything that is not a refusal is
 * thrown on: a policy that could not be read
 * (OrganizationRowUnavailableError) reaches the dashboard's "couldn't check
 * your access" card.
 */
function sendAway(e: unknown, elsewhere: string): never {
  if (e instanceof ServiceError && e.code === 'forbidden') {
    const reason = e.details?.reason;
    if (reason === 'mfa_required') redirect(AUTHENTICATOR_SET_UP_URL);
    if (reason === 'aal2_required') redirect(`/signin/mfa?redirect=${THIS_PAGE}`);
    redirect(elsewhere);
  }
  throw e;
}

/**
 * BLOCKED ACTIVITY: what the app refused that was about this organization,
 * for its owners and admins (server/services/security-events.ts holds the
 * gate and the reads).
 *
 * The page asks in the service's own order, with the service's own gate
 * (assertMaySeeSecurityActivity), before anything is read: the authenticator
 * step first, then the role. So a member who owes an authenticator is sent to
 * set-up, and one whose policy could not be read reaches the "couldn't check
 * your access" card, whatever their role; a member past that step who is not
 * an owner or admin is sent to Settings. A refusal from the reads themselves
 * (the database's own role and authenticator checks) is sent to the Security
 * page, or by its reason as above.
 */
export default async function BlockedActivityPage() {
  const ctx = await withContext();
  try {
    assertMaySeeSecurityActivity(ctx);
  } catch (e) {
    sendAway(e, '/dashboard/settings');
  }

  let activity: SecurityActivity;
  try {
    activity = await new SecurityEventsService(ctx).activity();
  } catch (e) {
    sendAway(e, '/dashboard/settings/security');
  }

  const { totals, rows } = activity;

  return (
    <SettingsPage width="wide">
      <PageHeader
        title="Blocked activity"
        subline="Wrong passwords and codes the app refused for the accounts in your organization. Kept for 90 days."
        back={
          <PageHeaderBackLink href="/dashboard/settings/security">
            ← Back to security
          </PageHeaderBackLink>
        }
      />

      <SettingsPanel
        title={`Last ${SECURITY_ACTIVITY_TOTALS_DAYS} days`}
        description="Blocked events by kind."
      >
        {totals === null ? (
          <p className="text-muted-foreground text-[13px]">
            Totals are not available right now: there are too many events to add up.
          </p>
        ) : totals.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            Nothing was blocked in the last {SECURITY_ACTIVITY_TOTALS_DAYS} days.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {totals.map((t) => (
              <div key={t.category} className="bg-sunk rounded-lg border px-4 py-3">
                <dt className="text-muted-foreground text-[12.5px]">
                  {securityEventCategoryLabel(t.category)}
                </dt>
                <dd className="text-foreground mt-1 font-mono text-[20px] tabular-nums">
                  {t.events.toLocaleString('en-US')}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </SettingsPanel>

      <SettingsPanel
        headingId="blocked-activity-recent-heading"
        landmark={rows.length === 0}
        title="Most recent"
        description={`The newest ${SECURITY_ACTIVITY_ROW_LIMIT} entries. Each entry counts events of one kind in one minute.`}
        flush
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-[18px] py-4 text-[13px]">
            No blocked activity yet.
          </p>
        ) : (
          <Table scrollLabelledBy="blocked-activity-recent-heading" className="min-w-[680px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Where</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const overCap = OVER_CAP.has(row.reason);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                      <AuditTime iso={row.lastSeenAt} />
                    </TableCell>
                    <TableCell>
                      <span className="text-foreground">{securityEventReasonLabel(row.reason)}</span>
                      <span className="text-muted-foreground block text-[12px]">
                        {securityEventCategoryLabel(row.category)} ·{' '}
                        {securityEventOutcomeLabel(row.outcome)}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {overCap ? '—' : securityEventPlaceLabel(row.country, row.city)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {securityEventSourceLabel(row.source)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.count.toLocaleString('en-US')}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SettingsPanel>
    </SettingsPage>
  );
}
