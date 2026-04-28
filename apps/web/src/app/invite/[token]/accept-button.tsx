'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { acceptInviteAction } from '@/server/actions/team';

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
    toast.success('Welcome to the team');
    router.replace('/dashboard');
    router.refresh();
  }

  return (
    <Button variant="gradient" className="w-full" onClick={accept} disabled={submitting}>
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Accept invite'}
    </Button>
  );
}
