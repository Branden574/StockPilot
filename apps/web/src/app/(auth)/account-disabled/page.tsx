import type { Metadata } from 'next';

import { AuthCard } from '@/components/auth/auth-card';
import { SignOutForm } from '@/components/auth/sign-out-form';

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
 * Living inside the group only buys the shared AuthLayout chrome (flat
 * background, mark, theme toggle) that every standalone auth surface uses.
 *
 * It reveals nothing: no reason, no actor, no date, no support ticket id. The
 * only affordance is signing out, so the user can try a different account. Note
 * this screen is for a CONFIRMED disable only — an unreadable status throws
 * instead, so a database problem renders the transient "Something went wrong"
 * boundary rather than telling an active user to call their administrator.
 *
 * Signing out is SignOutForm, a client component: before its request leaves,
 * it removes what an interrupted run kept in this tab (lib/interrupted-run),
 * which only the browser can do.
 */
export default function AccountDisabledPage() {
  return (
    <AuthCard eyebrow="Account status" title={ACCOUNT_DISABLED_TITLE} description={ACCOUNT_DISABLED_MESSAGE}>
      <SignOutForm />
    </AuthCard>
  );
}
