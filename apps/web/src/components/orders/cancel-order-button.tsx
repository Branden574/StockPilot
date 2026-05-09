'use client';

import { Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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

  if (TERMINAL.includes(status)) return null;

  async function cancel() {
    if (!window.confirm('Cancel this order request? Reservations will be released.')) {
      return;
    }
    setBusy(true);
    const res = await cancelOrderRequestAction({ id: orderId, reason: undefined });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Order request cancelled.');
    router.refresh();
  }

  return (
    <Button variant="ghost" onClick={cancel} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <X className="h-3.5 w-3.5" />
      )}
      Cancel request
    </Button>
  );
}
