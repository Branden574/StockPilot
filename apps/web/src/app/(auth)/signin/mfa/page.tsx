import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { MfaChallengeForm } from '@/components/auth/mfa-challenge-form';
import { Skeleton } from '@/components/ui/skeleton';
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

  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedTotp = (factorsData?.totp ?? []).find((f) => f.status === 'verified');

  // No verified factor → user shouldn't be here. Send them to the dashboard
  // (they're already signed in at AAL1, which is sufficient when no MFA exists).
  if (!verifiedTotp) redirect('/dashboard');

  // Already at AAL2? Skip the challenge.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === 'aal2') redirect('/dashboard');

  return (
    <AuthCard
      title="Two-factor authentication"
      description="One more step. Confirm it's you with a code from your authenticator app."
    >
      <Suspense fallback={<ChallengeSkeleton />}>
        <MfaChallengeForm factorId={verifiedTotp.id} />
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
