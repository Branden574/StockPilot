import type { Metadata } from 'next';
import Link from 'next/link';

import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { IconMark } from '@/components/ui/icon-mark';
import { getServerSession } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';

import { AcceptInviteButton } from './accept-button';
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
  if (invite) {
    const { data: org } = await admin
      .from('organizations')
      .select('name')
      .eq('id', invite.organization_id as string)
      .maybeSingle();
    if (org?.name) orgName = org.name as string;
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

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-mesh" />
      <header className="container mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/">
          <IconMark />
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md border-border/60 shadow-xl">
          <CardHeader className="text-center">
            {!invite ? (
              <>
                <CardTitle>Invite not found</CardTitle>
                <CardDescription>This link is invalid or no longer active.</CardDescription>
              </>
            ) : accepted ? (
              <>
                <CardTitle>Already accepted</CardTitle>
                <CardDescription>This invite was used. Sign in to access {orgName}.</CardDescription>
              </>
            ) : expired ? (
              <>
                <CardTitle>Invite expired</CardTitle>
                <CardDescription>Ask the inviter to send a new one.</CardDescription>
              </>
            ) : (
              <>
                <CardTitle>You're invited to {orgName}</CardTitle>
                <CardDescription>
                  Accept as <span className="font-medium text-foreground">{invite.email as string}</span>.
                </CardDescription>
              </>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {invite && !accepted && !expired && (
              <>
                {!session ? (
                  <>
                    <InviteSignupForm
                      token={token}
                      email={invite.email as string}
                    />
                    <div className="border-t border-border pt-3 text-center text-[12px] text-muted-foreground">
                      Already have an account?{' '}
                      <Link
                        href={`/signin?redirect=/invite/${token}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        Sign in
                      </Link>
                    </div>
                  </>
                ) : session.email.toLowerCase() !== (invite.email as string).toLowerCase() ? (
                  <p className="text-center text-sm text-muted-foreground">
                    You're signed in as <strong>{session.email}</strong>, but this invite is for{' '}
                    <strong>{invite.email as string}</strong>. Sign out and sign in with the right email to accept.
                  </p>
                ) : (
                  <AcceptInviteButton token={token} />
                )}
              </>
            )}
            {(accepted || expired) && (
              <Button asChild variant="outline" className="w-full">
                <Link href="/signin">Go to sign in</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
