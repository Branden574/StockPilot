'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { isControlFlow } from '@/lib/control-flow';
import { requestFailedMessage } from '@/lib/request-failure';
import { acceptInviteAction } from '@/server/actions/team';

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);

  async function accept() {
    setSubmitting(true);
    let res: Awaited<ReturnType<typeof acceptInviteAction>>;
    try {
      res = await acceptInviteAction({ token });
    } catch (e) {
      // A redirect (the session ended): the router is already navigating.
      if (isControlFlow(e)) return;
      toast.error(requestFailedMessage(e, 'accept the invite'));
      return;
    } finally {
      setSubmitting(false);
    }
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Invite accepted. Welcome to the team.');
    router.replace('/dashboard');
    router.refresh();
  }

  return (
    <Button
      variant="gradient"
      className="h-11 w-full text-[14px]"
      onClick={accept}
      disabled={submitting}
    >
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Accept invite'}
    </Button>
  );
}
