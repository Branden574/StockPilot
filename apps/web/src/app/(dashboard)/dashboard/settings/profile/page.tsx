import Link from 'next/link';

import { AvatarUploader } from '@/components/settings/avatar-uploader';
import { DeleteAccountButton } from '@/components/settings/delete-account-button';
import { EmailSettingsCard } from '@/components/settings/email-settings-card';
import { ProfileNameEditor } from '@/components/settings/profile-name-editor';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireSession } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';
import {
  getEmailChangeStatus,
  reconcileProfileEmail,
  type EmailChangeStatus,
} from '@/server/services/email-change';

export default async function ProfileSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const justChanged = params.emailChanged === '1';

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('full_name, avatar_url, email')
    .eq('id', session.userId)
    .maybeSingle();

  // The email card reads GoTrue directly: it is the identity AND the only
  // place a pending change lives. Reconcile first so a projection that ever
  // lagged the auth email is repaired on the page the user is looking at
  // (idempotent — a no-op when the two already agree). Never let an auth
  // read failure take the page down; fall back to the projection.
  let status: EmailChangeStatus | null = null;
  try {
    await reconcileProfileEmail(session.userId);
    status = await getEmailChangeStatus(session.userId);
  } catch (e) {
    void reportError(e, { tag: 'settings.profile.email_status_failed', level: 'warning' });
  }

  const fullName = (profile?.full_name as string | null) ?? null;
  const avatarUrl = (profile?.avatar_url as string | null) ?? null;
  const email = status?.email || (profile?.email as string | null) || session.email;

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to settings
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Your name, avatar, and sign-in email.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Avatar</CardTitle>
            <CardDescription>
              Square images look best. Max 5 MB. PNG, JPG, WEBP, or AVIF.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AvatarUploader
              userId={session.userId}
              initialUrl={avatarUrl}
              fullName={fullName}
              email={email}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Name</CardTitle>
            <CardDescription>
              Shown on movements, invites, and audit log entries you create.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileNameEditor current={fullName ?? ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Email</CardTitle>
            <CardDescription>
              Your sign-in email. Changing it requires confirming from both the current and the
              new address; account emails follow the new one once confirmed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EmailSettingsCard
              email={email}
              pendingEmail={status?.pendingEmail ?? null}
              sentAt={status?.sentAt ?? null}
              expiresAt={status?.expiresAt ?? null}
              expired={status?.expired ?? false}
              justChanged={justChanged}
            />
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Delete account</CardTitle>
            <CardDescription>
              Permanently remove your access to StockPilot and tombstone your
              profile. Historical records you touched stay attributed to your
              name. If you own a workspace with other members, transfer
              ownership first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteAccountButton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
