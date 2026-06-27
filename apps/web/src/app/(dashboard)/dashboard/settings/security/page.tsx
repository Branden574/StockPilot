import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { ActiveSessions } from '@/components/settings/active-sessions';
import { ChangePasswordForm } from '@/components/settings/change-password-form';
import { MfaEnrollment } from '@/components/settings/mfa-enrollment';
import { MfaPolicyEditor } from '@/components/settings/mfa-policy-editor';
import { MfaRecoveryCodes } from '@/components/settings/mfa-recovery-codes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { sessionIdFromJwt } from '@/lib/auth/api-context';
import { requireOrgContext } from '@/lib/auth/session';
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

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const currentSessionId = session?.access_token ? sessionIdFromJwt(session.access_token) : null;
  const activeSessions = await new SessionsService(await withContext())
    .list(currentSessionId)
    .catch(() => []);

  const [factorsRes, orgRow, recoveryStatus, aalRes] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
    getMfaRecoveryCodeStatus(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);

  const verifiedFactors = (factorsRes.data?.all ?? [])
    .filter((f) => f.status === 'verified')
    .map((f) => ({
      id: f.id,
      status: 'verified' as const,
      friendlyName: f.friendly_name ?? null,
    }));

  const policy = (orgRow.data?.mfa_policy as Policy | undefined) ?? 'optional';
  const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const policyRequired =
    policy === 'all_required' || (policy === 'admins_required' && isAdmin);

  // Supabase requires AAL2 to update the password when MFA is enabled.
  // If the user has verified factors but their current session is AAL1
  // (e.g. signed in before enrolling, or session loaded from a remember-me
  // cookie that didn't go through the MFA challenge), don't show the form
  // — show a step-up CTA pointing at /signin/mfa instead.
  const passwordChangeBlockedByMfa =
    verifiedFactors.length > 0 && aalRes.data?.currentLevel !== 'aal2';

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Two-factor authentication and your sign-in safety net.
        </p>
      </div>

      <div className="space-y-6">
        {enrollMode && verifiedFactors.length === 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
            <p className="font-medium">Enroll to continue</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Your organization requires two-factor authentication. Set up your
              authenticator app below to access the dashboard.
            </p>
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change password</CardTitle>
            <CardDescription>
              Update the password you use to sign in. You&apos;ll need your current password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {passwordChangeBlockedByMfa ? (
              <div className="border-border bg-muted/40 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">Verify it&apos;s you first</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Two-factor is on but this session hasn&apos;t completed
                      the MFA challenge. Step up with your authenticator code,
                      then come back here.
                    </p>
                  </div>
                </div>
                <Button asChild size="sm">
                  <Link href="/signin/mfa?redirect=/dashboard/settings/security">
                    Verify with code
                  </Link>
                </Button>
              </div>
            ) : (
              <ChangePasswordForm />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Authenticator app</CardTitle>
            <CardDescription>
              Use Google Authenticator, 1Password, or any TOTP app to add a 6-digit code at
              sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MfaEnrollment
              verifiedFactors={verifiedFactors}
              policyRequired={policyRequired}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active sessions</CardTitle>
            <CardDescription>
              Devices you&apos;re signed in on. Sign out any you don&apos;t recognize.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActiveSessions sessions={activeSessions} />
          </CardContent>
        </Card>

        {verifiedFactors.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recovery codes</CardTitle>
              <CardDescription>
                Single-use codes that let you back into your account if you
                lose access to your authenticator. Treat them like passwords.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MfaRecoveryCodes
                total={recoveryStatus.total}
                unused={recoveryStatus.unused}
              />
            </CardContent>
          </Card>
        )}

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Organization MFA policy</CardTitle>
              <CardDescription>
                Choose how strictly to require MFA across the team.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MfaPolicyEditor current={policy} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
