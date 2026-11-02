import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Mail } from 'lucide-react';
import type { ReactNode } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { ExternalShell } from '@/components/auth/external-shell';
import { SignOutForm } from '@/components/auth/sign-out-form';
import { CreateOrganizationForm } from '@/components/onboarding/create-organization-form';
import { DeleteAccountButton } from '@/components/settings/delete-account-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { IconMark } from '@/components/ui/icon-mark';
import { checkPlatformAdmin } from '@/lib/auth/platform-admin';
import { requireSession } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporter';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Workspace access',
};

/**
 * Where an account with no workspace lands: requireOrgContext sends it here.
 *
 * Only a platform admin creates a workspace (owner decision b.9, docket S20),
 * so the page decides what to show in this order:
 *   1. a member of a workspace goes to the dashboard;
 *   2. a membership read that failed gets a card that offers to try again, and
 *      nothing else is decided: an unreadable read is not "no workspace";
 *   3. a platform admin who passes the same checkPlatformAdmin({ requireStepUp:
 *      true }) as createOrganizationAction gets the create form, so the form
 *      never shows when the action would refuse it;
 *   4. everyone else (a removed member, a portal user, an invitee whose
 *      acceptance failed) gets the invite-only card: Sign out, the ordering
 *      portal, and Delete my account, which no other page offers an account
 *      with no workspace (Settings > Profile is inside the dashboard).
 * The action still runs its own check; this page only decides what to show.
 */
export default async function OnboardingPage() {
  const session = await requireSession();
  const supabase = await createClient();

  // If they already belong to an org, skip onboarding.
  const { data: existing, error: membershipError } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', session.userId)
    .not('accepted_at', 'is', null)
    .limit(1)
    .maybeSingle();

  if (existing) redirect('/dashboard');

  if (membershipError) {
    void reportError(new Error(membershipError.message), { tag: 'onboarding.membership_read' });
    return (
      <OnboardingFrame>
        <MembershipUnreadableCard />
      </OnboardingFrame>
    );
  }

  const gate = await checkPlatformAdmin({ requireStepUp: true });
  return (
    <OnboardingFrame>
      {gate.ok ? (
        <CreateWorkspaceCard />
      ) : (
        <InviteOnlyCard email={session.email} stepUpOwed={gate.reason === 'aal2_required'} />
      )}
    </OnboardingFrame>
  );
}

/**
 * The shared external frame and the auth card (P5.1): a flat ground (no mesh),
 * the brand link and the theme menu, and one card. The user has no workspace
 * yet, so there is no app navigation to show.
 */
function OnboardingFrame({ children }: { children: ReactNode }) {
  return (
    <ExternalShell
      width="lg"
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
      {children}
    </ExternalShell>
  );
}

function ProvisionLink() {
  return (
    <Link href="/platform/provision" className="text-foreground font-medium hover:underline">
      Platform &gt; Provision
    </Link>
  );
}

function CreateWorkspaceCard() {
  return (
    <AuthCard
      title="Create your workspace"
      description="We'll set you up with a default location so you can start adding inventory right away."
    >
      <CreateOrganizationForm />
      <p className="text-muted-foreground text-[12.5px]">
        Setting up a customer? Use <ProvisionLink />. It creates their account and their workspace,
        and makes them the owner.
      </p>
    </AuthCard>
  );
}

/**
 * `stepUpOwed`: the account's verified email is on the platform-admin
 * allowlist, but its session is at AAL1 or has no authenticator code from the
 * last 15 minutes. Only that person is told they are a platform admin.
 */
function InviteOnlyCard({ email, stepUpOwed }: { email: string; stepUpOwed: boolean }) {
  const signedInAs = email.trim();
  return (
    <AuthCard
      eyebrow="Invite only"
      title="Invite-only access"
      description={
        signedInAs
          ? `You're signed in as ${signedInAs}, and this account isn't part of a workspace yet.`
          : "This account isn't part of a workspace yet."
      }
    >
      <div className="bg-sunk text-ink-2 flex items-start gap-3 rounded-md p-3 text-[13px]">
        <Mail className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>
          StockPilot workspaces are invite-only. Ask your administrator to invite this email
          address, then open the invite email and choose{' '}
          <span className="text-foreground font-medium">Accept invitation</span>. If you already
          have an invite, open its link again.
        </p>
      </div>
      {stepUpOwed ? (
        // Plain text, no link: aal2_required also covers an AAL1 session, and
        // at AAL1 every /platform page answers 404 (requirePlatformAdmin).
        <p className="text-muted-foreground text-[12.5px]">
          You&apos;re a platform admin. To create a workspace here, sign out and sign in again with
          your authenticator; the form shows for 15 minutes after that. After you sign in again,
          Platform &gt; Provision sets up a customer&apos;s workspace.
        </p>
      ) : null}
      <p className="text-muted-foreground text-[12.5px]">
        Ordering from a supplier?{' '}
        <Link href="/portal" className="text-foreground font-medium hover:underline">
          Open your ordering portal
        </Link>
        .
      </p>
      <SignOutForm />
      <div className="border-border space-y-3 border-t pt-4">
        <p className="text-muted-foreground text-[12.5px]">
          Don&apos;t need this account any more?
        </p>
        <DeleteAccountButton />
      </div>
    </AuthCard>
  );
}

/** A failed membership read: no form, no invite text, no delete button. */
function MembershipUnreadableCard() {
  return (
    <AuthCard
      eyebrow="Workspace access"
      title="Your workspaces"
      description="We could not check your workspaces just now. Try again in a moment."
    >
      {/* A member lands on the dashboard once the read works; anyone else comes back here. */}
      <Button asChild className="h-11 w-full text-[14px]">
        <Link href="/dashboard">Try again</Link>
      </Button>
      <SignOutForm />
    </AuthCard>
  );
}
