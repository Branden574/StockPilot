'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { startActingAsAction } from '@/server/actions/platform/impersonation';

/**
 * "Act as this org" — enters impersonation (after the server-side AAL2
 * step-up) and drops the admin into the dashboard scoped to that org, with the
 * loud banner active. Confirms first because it grants live write access.
 */
export function ActAsButton({ organizationId, orgName }: { organizationId: string; orgName: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();

  function onClick() {
    if (
      !window.confirm(
        `Act as “${orgName}”? You'll be able to view AND edit their live data. Every action is logged, and the grant auto-expires in 45 minutes.`,
      )
    )
      return;
    start(async () => {
      const res = await startActingAsAction({ organizationId });
      if (res.ok) {
        toast.success(`Now acting as ${orgName}.`);
        router.push('/dashboard');
        router.refresh();
      } else if (res.error.details?.reason === 'aal2_required') {
        toast.error('Re-authenticate with MFA, then try again.');
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-md bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50"
    >
      {pending ? 'Entering…' : 'Act as this org'}
    </button>
  );
}
