import Link from 'next/link';

import { MfaEnrollment } from '@/components/settings/mfa-enrollment';
import { MfaPolicyEditor } from '@/components/settings/mfa-policy-editor';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

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

  const [factorsRes, orgRow] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase
      .from('organizations')
      .select('mfa_policy')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
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
