import 'server-only';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { Button } from '@/components/ui/button';
import { isModuleEnabled, withContext } from '@/server/services/context';

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
 *   - a module the report reads is off: the module-not-enabled card;
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
  const canManage = ctx.role === 'owner' || ctx.role === 'admin';
  for (const moduleId of reportModules(report)) {
    if (!isModuleEnabled(ctx, moduleId)) {
      return <ModuleNotEnabled moduleId={moduleId} canManage={canManage} />;
    }
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
    <div className="container mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div
        role="alert"
        className="border-warning/40 bg-warning/10 flex items-start gap-3 rounded-md border p-4"
      >
        <ShieldAlert aria-hidden className="text-warning mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-3">
          <p className="text-sm">{enrolled ? REPORT_MFA_VERIFY : REPORT_MFA_ENROLL}</p>
          <Button asChild size="sm">
            <Link
              href={
                enrolled
                  ? `/signin/mfa?redirect=${encodeURIComponent(here)}`
                  : '/dashboard/settings/security?enroll=1'
              }
            >
              {enrolled ? 'Verify now' : 'Set up two-step verification'}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
