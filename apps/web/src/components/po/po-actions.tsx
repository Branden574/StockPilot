'use client';

import { Send, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { updatePoStatusAction } from '@/server/actions/purchase-orders';

export function PoActions({ poId, status }: { poId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function setStatus(next: 'draft' | 'ordered' | 'cancelled') {
    setBusy(next);
    const res = await updatePoStatusAction(poId, next);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(`Marked as ${next}`);
    router.refresh();
  }

  return (
    <>
      {status === 'draft' && (
        <Button variant="default" disabled={busy === 'ordered'} onClick={() => setStatus('ordered')}>
          <Send className="h-4 w-4" /> Mark as ordered
        </Button>
      )}
      {status !== 'cancelled' && status !== 'received' && (
        <Button variant="outline" disabled={busy === 'cancelled'} onClick={() => setStatus('cancelled')}>
          <X className="h-4 w-4" /> Cancel PO
        </Button>
      )}
    </>
  );
}
