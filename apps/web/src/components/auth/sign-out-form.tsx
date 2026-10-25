'use client';

import { Button } from '@/components/ui/button';
import { purgeInterruptedRuns } from '@/lib/interrupted-run';
import { signOutAction } from '@/server/actions/auth';

/**
 * A Sign out button for a page rendered on the server (the account-disabled
 * screen). Still a form that posts signOutAction, so it works before the
 * page's JavaScript has loaded. Once it has, submitting first removes what an
 * interrupted run kept in this tab (lib/interrupted-run): a sign-out on
 * purpose leaves none of it. React runs onSubmit before the form's action, and
 * the purge never throws, so the sign-out always goes ahead. (Before the
 * JavaScript loads there is nothing to run it; a record then stays only until
 * another account's app shell removes it or the tab closes.)
 */
export function SignOutForm() {
  return (
    <form action={signOutAction} onSubmit={() => purgeInterruptedRuns()}>
      <Button type="submit" variant="outline" className="h-11 w-full text-[14px]">
        Sign out
      </Button>
    </form>
  );
}
