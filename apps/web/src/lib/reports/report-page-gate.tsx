import 'server-only';

import { redirect } from 'next/navigation';

import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { ReportMfaCard } from '@/components/reports/report-mfa-state';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { withContext } from '@/server/services/context';

import { can } from '@stockpilot/core';

import { reportModules, type ReportSlug } from './report-access';

export const REPORT_MFA_ENROLL =
  'Set up two-step verification to open this report. Your organization requires it for admins.';
export const REPORT_MFA_VERIFY = 'Verify with your authenticator app to open this report.';

/**
 * A report page's own check, run before it reads anything. The reports layout
 * checks reports:read too, but a layout's check does not stop its page from
 * rendering, so every report page asks for itself:
 *   - no reports:read: back to the dashboard (what the layout does);
 *   - a module the report reads is off: the module-not-enabled card, or,
 *     when the module set could not be read, "We couldn't check whether this
 *     module is on" with Try again (checkModuleAccess's checkFailed, read
 *     from the same request-cached set, so no extra round trip);
 *   - the MFA step-up the service gate would refuse with: a state that says
 *     what to do, never an error page.
 * Returns null when the page may render. The data path checks again
 * (ReportsService.gate), so this is the page's courtesy, not the only floor.
 *
 * withContext() is React-cached per request: the page body's
 * ReportsService.forCurrentUser() reuses this same context, so the check costs
 * no extra round trip.
 */
export async function reportPageGate(report: ReportSlug): Promise<React.ReactElement | null> {
  const ctx = await withContext();
  if (!can(ctx, 'reports:read')) redirect('/dashboard');
  for (const moduleId of reportModules(report)) {
    // The page gate answers from the same request-cached read the context's
    // set is built from, and it has all three answers: on, off, and "could
    // not check" (checkFailed). Asking the context instead would throw for a
    // state that was not read (ModulesUnavailableError), and this page has a
    // state for that.
    const access = await checkModuleAccess(moduleId);
    if (!access.enabled) return <ModuleUnavailable moduleId={moduleId} access={access} />;
  }
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    return <ReportMfaState enrolled={ctx.mfaEnrolled === true} report={report} />;
  }
  return null;
}

/** The MFA refusal as a state, not an error page (the Book Order Totals
 *  pattern, for every report). */
export function ReportMfaState({ enrolled, report }: { enrolled: boolean; report: ReportSlug }) {
  const here = `/dashboard/reports/${report}`;
  return (
    <ReportMfaCard
      message={enrolled ? REPORT_MFA_VERIFY : REPORT_MFA_ENROLL}
      href={
        enrolled
          ? `/signin/mfa?redirect=${encodeURIComponent(here)}`
          : '/dashboard/settings/security?enroll=1'
      }
      actionLabel={enrolled ? 'Verify now' : 'Set up two-step verification'}
    />
  );
}
