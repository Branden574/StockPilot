'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { acceptInviteAction } from '@/server/actions/team';

import { INVITE_ALREADY_MEMBER_TOAST } from './invite-copy';

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);

  async function accept() {
    setSubmitting(true);
    const res = await acceptInviteAction({ token });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    // Already a member: the membership was left as it was.
    if (res.data.alreadyMember) toast.info(INVITE_ALREADY_MEMBER_TOAST);
    else toast.success('Invite accepted. Welcome to the team.');
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
