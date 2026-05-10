'use client';

import { Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { cancelOrderRequestAction } from '@/server/actions/order-requests';

import type { OrderRequestStatus } from '@/server/services/order-requests';

const TERMINAL: OrderRequestStatus[] = ['delivered', 'denied', 'cancelled'];

interface Props {
  orderId: string;
  status: OrderRequestStatus;
}

export function CancelOrderButton({ orderId, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  if (TERMINAL.includes(status)) return null;

  async function confirmCancel() {
    setBusy(true);
    const res = await cancelOrderRequestAction({ id: orderId, reason: undefined });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setOpen(false);
    toast.success('Order request cancelled.');
    router.refresh();
  }

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} disabled={busy}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
        Cancel request
      </Button>
      <DestructiveConfirm
        open={open}
        onOpenChange={setOpen}
        title="Cancel this order request?"
        description="The request is marked cancelled and any stock reservations attached to it are released back to available stock. The request stays on the record for the audit trail."
        confirmLabel="Cancel request"
        cancelLabel="Keep request"
        pending={busy}
        onConfirm={confirmCancel}
      />
    </>
  );
}
