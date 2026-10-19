'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
    <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending}>
      {pending ? 'Exiting…' : 'Exit — back to my workspace'}
    </Button>
  );
}
