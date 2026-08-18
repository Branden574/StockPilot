import type { Metadata } from 'next';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { signOutAction } from '@/server/actions/auth';

import { ACCOUNT_DISABLED_MESSAGE, ACCOUNT_DISABLED_TITLE } from '@stockpilot/core';

export const metadata: Metadata = { title: 'Account disabled' };

/**
 * The blocked-route screen — the destination of `assertAccountActiveOrRedirect`
 * and of a `user_banned` sign-in.
 *
 * Loop safety: `(auth)` is a ROUTE GROUP, so the URL stays `/account-disabled`
 * — outside the (dashboard) group, outside the proxy matcher, and calling no
 * session helper. The destination of a blocking redirect must itself be exempt
 * from that redirect, which is the lesson the MFA gate learned the hard way.
 * Living inside the group only buys the shared AuthLayout chrome (mesh
 * background, mark, theme toggle) that every standalone auth surface uses.
 *
 * It reveals nothing: no reason, no actor, no date, no support ticket id. The
 * only affordance is signing out, so the user can try a different account. Note
 * this screen is for a CONFIRMED disable only — an unreadable status throws
 * instead, so a database problem renders the transient "Something went wrong"
 * boundary rather than telling an active user to call their administrator.
 */
export default function AccountDisabledPage() {
  return (
    <AuthCard eyebrow="Account status" title={ACCOUNT_DISABLED_TITLE} description={ACCOUNT_DISABLED_MESSAGE}>
      <form action={signOutAction}>
        <Button type="submit" variant="outline" className="w-full">
          Sign out
        </Button>
      </form>
    </AuthCard>
  );
}
