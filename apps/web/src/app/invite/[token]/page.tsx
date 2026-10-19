import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';
import { ExternalShell } from '@/components/auth/external-shell';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { IconMark } from '@/components/ui/icon-mark';
import { getServerSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

import { AcceptInviteButton } from './accept-button';
import { inviteExpiredDescription } from './invite-copy';
import { InviteSignupForm } from './signup-form';

/**
 * Per-token OG metadata so chat-client unfurls (Teams/Slack/iMessage) link
 * to THIS specific invite URL — not the home page. Without this, Teams'
 * link preview falls back to the root og:url and clicks bypass the token.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const url = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/invite/${token}`;
  return {
    title: 'You have a StockPilot invite',
    description: 'Click to accept and set up your account.',
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    openGraph: {
      title: 'You have a StockPilot invite',
      description: 'Accept your invite and set up your account.',
      url,
      siteName: 'StockPilot',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: 'You have a StockPilot invite',
      description: 'Accept your invite and set up your account.',
    },
    robots: { index: false, follow: false },
    alternates: { canonical: url },
  };
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: invite } = await admin
    .from('organization_invites')
    .select('id, organization_id, email, role, expires_at, accepted_at')
    .eq('token', token)
    .maybeSingle();

  let orgName = 'a workspace';
  let orgKnown = false;
  if (invite) {
    const { data: org } = await admin
      .from('organizations')
      .select('name')
      .eq('id', invite.organization_id as string)
      .maybeSingle();
    if (org?.name) {
      orgName = org.name as string;
      orgKnown = true;
    }
  }

  const session = await getServerSession();
  const expired = invite ? new Date(invite.expires_at as string).getTime() < Date.now() : false;
  const accepted = Boolean(invite?.accepted_at);

  // NO auto-accept during render. Two reasons:
  //  1. acceptInviteAction ends with revalidatePath, which Next 16 throws
  //     on during the render phase — the membership was committed but the
  //     action reported failure, so the invitee saw a stale "You're
  //     invited" page and then an "Invite already accepted" error on
  //     click (silently-broken onboarding, found in the 2026-07-02 sweep).
  //  2. Mutating on a bare GET means any cookie-carrying prefetch would
  //     accept the invite without a human action.
  // The signed-in matching user simply presses Accept (one click, POSTs
  // through the action like every other mutation).

  const signupOpen = Boolean(invite && !accepted && !expired && !session);
  const body =
    invite && !accepted && !expired ? (
      !session ? (
        <InviteSignupForm token={token} email={invite.email as string} />
      ) : session.email.toLowerCase() !== (invite.email as string).toLowerCase() ? (
        <p className="text-muted-foreground text-[13.5px] leading-[20.25px]">
          You're signed in as{' '}
          <strong className="text-foreground font-medium">{session.email}</strong>, but this invite
          is for <strong className="text-foreground font-medium">{invite.email as string}</strong>.
          Sign out and sign in with the right email to accept.
        </p>
      ) : (
        <AcceptInviteButton token={token} />
      )
    ) : accepted || expired ? (
      <Button asChild variant="outline" className="h-11 w-full text-[14px]">
        <Link href="/signin">Go to sign in</Link>
      </Button>
    ) : null;

  // The redesign draws the invite on the shared external frame and the auth
  // card (P5.1), so the invitee sees the same product as /signin: a flat
  // ground (no mesh), the brand link and the theme menu above one column.
  return (
    <ExternalShell
      width="md"
      topBar={
        <>
          <Link
            href="/"
            className="focus-visible:ring-ring rounded-md focus-visible:outline-none focus-visible:ring-2"
          >
            <IconMark />
          </Link>
          <ThemeToggle />
        </>
      }
    >
      <AuthCard
        title={
          !invite
            ? 'Invite not found'
            : accepted
              ? 'Already accepted'
              : expired
                ? 'Invite expired'
                : `You're invited to ${orgName}`
        }
        description={
          !invite ? (
            'This link is invalid or no longer active.'
          ) : accepted ? (
            `This invite was used. Sign in to access ${orgName}.`
          ) : expired ? (
            inviteExpiredDescription(orgKnown ? orgName : null)
          ) : (
            <>
              Accept as{' '}
              <span className="text-foreground font-medium">{invite.email as string}</span>.
            </>
          )
        }
        footer={
          signupOpen ? (
            <>
              Already have an account?{' '}
              <Link
                href={`/signin?redirect=/invite/${token}`}
                className="text-foreground font-medium hover:underline"
              >
                Sign in
              </Link>
            </>
          ) : undefined
        }
      >
        {body}
      </AuthCard>
    </ExternalShell>
  );
}
