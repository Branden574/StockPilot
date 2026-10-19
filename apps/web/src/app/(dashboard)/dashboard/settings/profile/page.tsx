import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { AvatarUploader } from '@/components/settings/avatar-uploader';
import { DeleteAccountButton } from '@/components/settings/delete-account-button';
import { DELETE_ACCOUNT_CARD_COPY } from '@/components/settings/delete-account-copy';
import { EmailSettingsCard } from '@/components/settings/email-settings-card';
import { ProfileNameEditor } from '@/components/settings/profile-name-editor';
import { SettingsPage, SettingsPanel } from '@/components/settings/settings-nav';
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
    <SettingsPage>
      <PageHeader
        title="Profile"
        subline="Your name, avatar, and sign-in email."
        back={
          <PageHeaderBackLink href="/dashboard/settings">← Back to settings</PageHeaderBackLink>
        }
      />

      <SettingsPanel
        title="Avatar"
        description="Square images look best. Max 5 MB. PNG, JPG, WEBP, or AVIF."
      >
        <AvatarUploader
          userId={session.userId}
          initialUrl={avatarUrl}
          fullName={fullName}
          email={email}
        />
      </SettingsPanel>

      <SettingsPanel
        title="Name"
        description="Shown on movements, invites, and audit log entries you create."
      >
        <ProfileNameEditor current={fullName ?? ''} />
      </SettingsPanel>

      <SettingsPanel
        title="Email"
        description="Your sign-in email. Changing it requires confirming from both the current and the new address; account emails follow the new one once confirmed."
      >
        <EmailSettingsCard
          email={email}
          pendingEmail={status?.pendingEmail ?? null}
          sentAt={status?.sentAt ?? null}
          expiresAt={status?.expiresAt ?? null}
          expired={status?.expired ?? false}
          justChanged={justChanged}
        />
      </SettingsPanel>

      {/* The danger zone: set apart below the everyday cards, destructive in
          its edge, its title and its button, and in its words. */}
      <SettingsPanel tone="danger" title="Delete account" description={DELETE_ACCOUNT_CARD_COPY}>
        <DeleteAccountButton />
      </SettingsPanel>
    </SettingsPage>
  );
}
