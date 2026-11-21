import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { MfaChallengeForm } from '@/components/auth/mfa-challenge-form';
import { Skeleton } from '@/components/ui/skeleton';
import {
  appFactorsForCode,
  passkeyRecordsUnread,
  readPasskeyBridge,
} from '@/lib/auth/passkey-bridge';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Two-factor authentication',
  description: 'Enter your authenticator code to continue.',
};

export default async function MfaChallengePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/signin');

  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  // An unreadable factor list is NOT "no factor": treating it as one sent an
  // enrolled user straight to the dashboard at AAL1, past this challenge.
  if (factorsError) {
    return (
      <AuthCard
        eyebrow="Two-factor"
        title="Two-factor authentication"
        description="We could not load your authenticator just now. Reload this page to try again."
      />
    );
  }
  const verifiedTotp = (factorsData?.totp ?? []).filter((f) => f.status === 'verified');

  // No verified factor → user shouldn't be here. Send them to the dashboard
  // (they're already signed in at AAL1, which is sufficient when no MFA exists).
  // A passkey's bridge is a verified factor, so an account whose only second
  // step is a passkey stays here: the dashboard would send it straight back.
  if (verifiedTotp.length === 0) redirect('/dashboard');

  // Already at AAL2? Skip the challenge.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === 'aal2') redirect('/dashboard');

  // D5: when more than one TOTP factor is verified (eg. user has both
  // phone + hardware backup app), pass the full list so the form can
  // let them pick which one they want to challenge against. Never the
  // account's recorded passkey bridge (lib/auth/passkey-bridge): no app
  // shows its code. Nor any other factor carrying the reserved name,
  // whatever the record read answered (the lab walk of stage 4, state S12;
  // fail closed while the record cannot be read): its code is one no member
  // has, so an account left with no app gets the words below. An account
  // with no reserved-name factor makes no record read.
  const bridge = await readPasskeyBridge(user.id, verifiedTotp, 'sign_in_page');
  const factors = appFactorsForCode(verifiedTotp, bridge).map((f) => ({
    id: f.id,
    friendlyName:
      (f.friendly_name as string | null) ?? null,
  }));

  // Only a passkey, which this page cannot take yet: the recovery code is
  // the way in (the form shows no code box without an app).
  if (factors.length === 0) {
    // The bridge record could not be read (a failed read, or the table
    // missing): a passing fault, not a second step that cannot be used. The
    // page's own words for a list it could not load, and no form.
    if (passkeyRecordsUnread(bridge)) {
      return (
        <AuthCard
          eyebrow="Two-factor"
          title="Two-factor authentication"
          description="We could not load your authenticator just now. Reload this page to try again."
        />
      );
    }
    return (
      <AuthCard
        eyebrow="Two-factor"
        title="Two-factor authentication"
        description="Your second step can't be used here right now. Use a recovery code to get back in, or try again later."
      >
        <Suspense fallback={<ChallengeSkeleton />}>
          <MfaChallengeForm factors={[]} />
        </Suspense>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      eyebrow="Two-factor"
      title="Two-factor authentication"
      description="One more step. Confirm it's you with a code from your authenticator app."
    >
      <Suspense fallback={<ChallengeSkeleton />}>
        <MfaChallengeForm factors={factors} />
      </Suspense>
    </AuthCard>
  );
}

function ChallengeSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
