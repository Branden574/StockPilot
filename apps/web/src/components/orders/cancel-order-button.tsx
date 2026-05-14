'use client';

import { Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  // I8: optional reason textarea. Captured in component state and sent
  // through to the action when the user confirms. Reset on close so a
  // half-typed reason doesn't leak into the next request the user
  // cancels in the same session.
  const [reason, setReason] = React.useState('');

  // Reset reason whenever the dialog closes — covers both confirm-path
  // and explicit-dismiss.
  React.useEffect(() => {
    if (!open) setReason('');
  }, [open]);

  if (TERMINAL.includes(status)) return null;

  async function confirmCancel() {
    setBusy(true);
    const trimmed = reason.trim();
    const res = await cancelOrderRequestAction({
      id: orderId,
      reason: trimmed.length > 0 ? trimmed : undefined,
    });
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
        description={
          <div className="space-y-3">
            <p>
              The request is marked cancelled and any stock reservations
              attached to it are released back to available stock. The
              request stays on the record for the audit trail.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="cancel-order-reason">
                Reason
                <span className="ml-1 font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="cancel-order-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being cancelled?"
                maxLength={500}
                rows={3}
                disabled={busy}
              />
            </div>
          </div>
        }
        confirmLabel="Cancel request"
        cancelLabel="Keep request"
        pending={busy}
        onConfirm={confirmCancel}
      />
    </>
  );
}
