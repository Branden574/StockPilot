'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { PasskeyButton } from '@/components/auth/passkey-button';
import { safeRedirectPath } from '@/lib/auth/safe-redirect';

/**
 * The passkey above the code form on the second-step page (plan section 4).
 * With an authenticator app too, a divider says the code still works.
 */
export function PasskeyStep({ hasApps }: { hasApps: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = safeRedirectPath(params.get('redirect'));
  return (
    <div className="mb-4 space-y-4">
      <PasskeyButton
        onPassed={() => {
          router.replace(redirect);
          router.refresh();
        }}
        onRemovalFinished={() => router.refresh()}
      />
      {hasApps ? (
        <p className="text-muted-foreground text-center text-[12px]">
          Or enter the 6-digit code from your authenticator app
        </p>
      ) : null}
    </div>
  );
}
