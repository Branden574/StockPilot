'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
import { startActingAsAction } from '@/server/actions/platform/impersonation';

/**
 * "Act as this org" — enters impersonation (after the server-side AAL2
 * step-up) and drops the admin into the dashboard scoped to that org, with the
 * loud banner active. Confirms first because it grants live write access.
 *
 * When the fresh MFA step-up has lapsed the action returns `aal2_required`; we
 * prompt for the authenticator code in-place (no sign-out) and retry.
 */
export function ActAsButton({
  organizationId,
  orgName,
}: {
  organizationId: string;
  orgName: string;
}) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [pending, start] = React.useTransition();

  function onClick() {
    if (
      !window.confirm(
        `Act as “${orgName}”? You'll be able to view AND edit their live data. Every action is logged, and the grant auto-expires in 45 minutes.`,
      )
    )
      return;
    start(async () => {
      const payload = { organizationId };
      let res = await startActingAsAction(payload);
      // Fresh MFA step-up needed → prompt for the authenticator code in-place
      // (no sign-out) and retry with the identical payload.
      if (!res.ok && res.error.details?.reason === 'aal2_required') {
        if (!(await stepUp.ensure())) return;
        res = await startActingAsAction(payload);
      }
      if (res.ok) {
        toast.success(`Now acting as ${orgName}.`);
        router.push('/dashboard');
        router.refresh();
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <>
      {stepUp.modal}
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="bg-foreground text-background rounded-md px-3 py-1.5 text-[12.5px] font-medium hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Entering…' : 'Act as this org'}
      </button>
    </>
  );
}
