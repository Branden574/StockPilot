import { ShieldCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { ActiveSessions } from '@/components/settings/active-sessions';
import { ChangePasswordForm } from '@/components/settings/change-password-form';
import { MfaEnrollment } from '@/components/settings/mfa-enrollment';
import { MfaPolicyEditor } from '@/components/settings/mfa-policy-editor';
import { MfaRecoveryCodes } from '@/components/settings/mfa-recovery-codes';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
import { Button } from '@/components/ui/button';
import { enforcedMfaPolicy } from '@/lib/auth/mfa-policy';
import { requireOrgContext } from '@/lib/auth/session';
import { getVerifiedSessionClaimsForRequest } from '@/lib/auth/verified-claims';
import { createClient } from '@/lib/supabase/server';
import { getMfaRecoveryCodeStatus } from '@/server/actions/mfa-recovery';
import { withContext } from '@/server/services/context';
import { SessionsService } from '@/server/services/sessions';

type Policy = 'optional' | 'admins_required' | 'all_required';

export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ enroll?: string }>;
}) {
  const params = await searchParams;
  const enrollMode = params.enroll === '1';
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  // This device's session id and its assurance level both come from the
  // access token once its signature checks out (lib/auth/verified-claims: a
  // local ES256 check, no Auth round trip once the key set is cached). They
  // used to come from the cookie unchecked: getSession()'s token for the id,
  // and getAuthenticatorAssuranceLevel(), which also read the cookie's stored
  // user object (auth-js logs that as insecure on a server client). A token
  // that does not verify marks no session as this one and is not AAL2.
  // The read is the one the dashboard layout started (request-cached), and
  // the service context starts beside it: on a cold key set, the key-set
  // fetch must not hold up the context's own round trips.
  const [claims, serviceContext] = await Promise.all([
    getVerifiedSessionClaimsForRequest(),
    withContext(),
  ]);
  const currentSessionId = claims?.sessionId ?? null;
  const activeSessions = await new SessionsService(serviceContext)
    .list(currentSessionId)
    .catch(() => []);

  const [factorsRes, orgRow, recoveryStatus] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.from('organizations').select('mfa_policy').eq('id', ctx.organizationId).maybeSingle(),
    getMfaRecoveryCodeStatus(),
  ]);

  // Display only (every action on this page re-checks server-side), but an
  // unreadable list must not read as "not enrolled": that tells an enrolled
  // user to set up an authenticator they already have. It gets its own state.
  const factorsUnreadable = Boolean(factorsRes.error);
  const verifiedFactors = (factorsRes.data?.all ?? [])
    .filter((f) => f.status === 'verified')
    .map((f) => ({
      id: f.id,
      status: 'verified' as const,
      friendlyName: f.friendly_name ?? null,
    }));

  // Same rule as the gates that send people here and the action behind the
  // Remove button: a row this member cannot read is held to the strictest
  // policy (lib/auth/mfa-policy.ts), so the page never says "optional" while
  // the layout is demanding enrollment.
  const policy: Policy = enforcedMfaPolicy(orgRow.data);
  const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const policyRequired = policy === 'all_required' || (policy === 'admins_required' && isAdmin);

  // Supabase requires AAL2 to update the password when MFA is enabled.
  // If the user has verified factors but their current session is AAL1
  // (e.g. signed in before enrolling, or session loaded from a remember-me
  // cookie that didn't go through the MFA challenge), don't show the form
  // — show a step-up CTA pointing at /signin/mfa instead.
  // With the factor list unreadable, "no verified factors" is not known, and
  // an enrolled user at AAL1 must not be shown a form the action will refuse,
  // so only a verified AAL2 session gets the form. (The session's own
  // `nextLevel` used to decide here; it came from the cookie's stored user
  // object, which nothing verifies. The action itself refuses while the list
  // is unreadable either way.)
  const hasVerifiedFactor = factorsUnreadable || verifiedFactors.length > 0;
  const passwordChangeBlockedByMfa = hasVerifiedFactor && claims?.aal !== 'aal2';

  return (
    <SettingsPage>
      <PageHeader
        title="Security"
        subline="Two-factor authentication and your sign-in safety net."
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      {enrollMode && !factorsUnreadable && verifiedFactors.length === 0 && (
        <div className="border-warning/40 bg-warning-wash flex items-start gap-3 rounded-lg border px-4 py-3 text-[13px]">
          <TriangleAlert aria-hidden className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Enroll to continue</p>
            <p className="text-ink-2 mt-0.5 text-[12.5px]">
              Your organization requires two-factor authentication. Set up your authenticator app
              below to access the dashboard.
            </p>
          </div>
        </div>
      )}

      <SettingsPanel
        title="Change password"
        description="Update the password you use to sign in. You'll need your current password."
      >
        {passwordChangeBlockedByMfa ? (
          <div className="border-border bg-sunk flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <ShieldCheck aria-hidden className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-[13px]">
                <p className="font-medium">Verify it&apos;s you first</p>
                <p className="text-muted-foreground mt-0.5 text-[12.5px]">
                  Two-factor is on but this session hasn&apos;t completed the MFA challenge. Step up
                  with your authenticator code, then come back here.
                </p>
              </div>
            </div>
            <Button asChild size="sm" className="self-start sm:self-auto">
              <Link href="/signin/mfa?redirect=/dashboard/settings/security">Verify with code</Link>
            </Button>
          </div>
        ) : (
          <ChangePasswordForm />
        )}
      </SettingsPanel>

      <SettingsPanel
        title="Authenticator app"
        description="Use Google Authenticator, 1Password, or any TOTP app to add a 6-digit code at sign-in."
      >
        {factorsUnreadable ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive-wash flex items-start gap-3 rounded-lg border p-4 text-[13px]"
          >
            <TriangleAlert aria-hidden className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">Could not load your authenticator status</p>
              <p className="text-ink-2 mt-0.5 text-[12.5px]">
                Nothing about your two-factor setup has changed; this page could not read it.{' '}
                <Link
                  href={
                    enrollMode
                      ? '/dashboard/settings/security?enroll=1'
                      : '/dashboard/settings/security'
                  }
                  className="text-foreground font-medium underline underline-offset-4"
                >
                  Try again
                </Link>
              </p>
            </div>
          </div>
        ) : (
          <MfaEnrollment verifiedFactors={verifiedFactors} policyRequired={policyRequired} />
        )}
      </SettingsPanel>

      <SettingsPanel
        title="Active sessions"
        description="Devices you're signed in on. Sign out any you don't recognize."
      >
        <ActiveSessions sessions={activeSessions} />
      </SettingsPanel>

      {verifiedFactors.length > 0 && (
        <SettingsPanel
          title="Recovery codes"
          description="Single-use codes that let you back into your account if you lose access to your authenticator. Treat them like passwords."
        >
          <MfaRecoveryCodes total={recoveryStatus.total} unused={recoveryStatus.unused} />
        </SettingsPanel>
      )}

      {isAdmin && (
        <SettingsPanel
          title="Organization MFA policy"
          description="Choose how strictly to require MFA across the team."
        >
          <MfaPolicyEditor current={policy} />
        </SettingsPanel>
      )}
    </SettingsPage>
  );
}
