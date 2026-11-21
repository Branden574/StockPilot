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
import {
  signInAlertAnswerWords,
  signInAlertKindWords,
  signInAlertPlaceWords,
} from '@/lib/auth/sign-in-alert-words';
import { ServiceError, withContext } from '@/server/services/context';
import {
  assertMaySeeSignInAlerts,
  SIGN_IN_ALERTS_ROW_LIMIT,
  SignInAlertsService,
  type OrganizationSignInAlert,
} from '@/server/services/sign-in-alerts';

import { securityEventSourceLabel } from '@stockpilot/core';

// The Liquid Glass settings and administration composition (stage 4:
// pages/admin.css): every rule is scoped to this area's [data-glass-page] root
// and to glass, so Classic never matches it (glass-scope.guard.test.ts).
import '@/styles/liquid-glass/pages/admin.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign-in alerts — Settings' };

const THIS_PAGE = '/dashboard/settings/security/sign-ins';

/**
 * A refusal, turned into where the member is sent (the Blocked activity
 * page's rule): to set-up when an authenticator is owed, to the code page when
 * this session has not given its code, otherwise to `elsewhere`. Anything
 * that is not a refusal is thrown on: a policy that could not be read
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
 * SIGN-IN ALERTS (part 3 of the security tools): the alerts the members of
 * this organization were sent for a sign-in from a new device or a new
 * country, and how each member answered. For owners and admins
 * (server/services/sign-in-alerts.ts holds the gate and the read).
 *
 * Asked in the Blocked activity page's order, with the service's own gate
 * (assertMaySeeSignInAlerts), before anything is read: the authenticator step
 * first, then the role. A refusal from the read itself (the database's own
 * role and authenticator checks) goes to the Security page, or by its reason.
 *
 * The device is the FAMILY ("Chrome on macOS"): a member's own name for a
 * device is theirs, and the list never shows it.
 */
export default async function SignInAlertsPage() {
  const ctx = await withContext();
  try {
    assertMaySeeSignInAlerts(ctx);
  } catch (e) {
    sendAway(e, '/dashboard/settings');
  }

  let rows: OrganizationSignInAlert[];
  try {
    rows = await new SignInAlertsService(ctx).forOrganization();
  } catch (e) {
    sendAway(e, '/dashboard/settings/security');
  }

  return (
    <SettingsPage width="wide">
      <PageHeader
        title="Sign-in alerts"
        subline="Sign-ins from a new device or a new country, and how each member answered. Kept for 90 days."
        back={
          <PageHeaderBackLink href="/dashboard/settings/security">
            ← Back to security
          </PageHeaderBackLink>
        }
      />

      <SettingsPanel
        headingId="sign-in-alerts-heading"
        landmark={rows.length === 0}
        title="Most recent"
        description={`The newest ${SIGN_IN_ALERTS_ROW_LIMIT} alerts. When a member says a sign-in was not them, every session of their account ends.`}
        flush
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-[18px] py-4 text-[13px]">
            No sign-in alerts in the last 90 days.
          </p>
        ) : (
          <Table scrollLabelledBy="sign-in-alerts-heading" className="min-w-[760px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Place</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Answer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-[12.5px]">
                    <AuditTime iso={row.createdAt} />
                  </TableCell>
                  <TableCell>
                    {row.fullName ? (
                      <>
                        <span className="text-foreground">{row.fullName}</span>
                        <span className="text-muted-foreground block text-[12px]">{row.email}</span>
                      </>
                    ) : (
                      <span className="text-foreground">{row.email ?? 'Unknown member'}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-foreground">{row.deviceFamily}</span>
                    <span className="text-muted-foreground block text-[12px]">
                      {securityEventSourceLabel(row.client)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {signInAlertPlaceWords(row.country, row.city) ?? 'Unknown'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {signInAlertKindWords({ newDevice: row.newDevice, newCountry: row.newCountry })}
                  </TableCell>
                  <TableCell
                    className={row.status === 'not_me' ? 'text-destructive font-medium' : 'text-muted-foreground'}
                  >
                    {signInAlertAnswerWords(row.status)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsPanel>
    </SettingsPage>
  );
}
