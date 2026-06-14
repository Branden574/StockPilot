'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { stopActingAsAction } from '@/server/actions/platform/impersonation';

/** Exits impersonation and returns the admin to their own workspace. */
export function StopActingAsButton() {
  const router = useRouter();
  const [pending, start] = React.useTransition();

  function onClick() {
    start(async () => {
      const res = await stopActingAsAction();
      if (res.ok) {
        toast.success('Stopped acting as the organization.');
        router.push('/platform');
        router.refresh();
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
      className="rounded-md border border-amber-600/50 bg-background/60 px-2.5 py-1 text-[12px] font-semibold hover:bg-background disabled:opacity-50"
    >
      {pending ? 'Exiting…' : 'Exit — back to my workspace'}
    </button>
  );
}
