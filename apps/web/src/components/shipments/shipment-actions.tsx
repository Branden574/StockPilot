'use client';

import { Send, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  markShipmentCancelledAction,
  markShipmentShippedAction,
} from '@/server/actions/shipments';

import type { ShipmentStatus } from '@/server/services/shipments';

export function ShipmentActions({
  shipmentId,
  status,
}: {
  shipmentId: string;
  status: ShipmentStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<'ship' | 'cancel' | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);

  async function markShipped() {
    setBusy('ship');
    const res = await markShipmentShippedAction(shipmentId);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Shipment marked as shipped.');
    router.refresh();
  }

  async function cancel() {
    setBusy('cancel');
    const res = await markShipmentCancelledAction(shipmentId);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setCancelOpen(false);
    toast.success('Shipment cancelled.');
    router.refresh();
  }

  return (
    <>
      {status === 'draft' && (
        <Button variant="default" disabled={busy === 'ship'} onClick={markShipped}>
          <Send className="h-4 w-4" /> Mark shipped
        </Button>
      )}
      {status !== 'delivered' && status !== 'cancelled' && (
        <Button
          variant="outline"
          disabled={busy === 'cancel'}
          onClick={() => setCancelOpen(true)}
        >
          <X className="h-4 w-4" /> Cancel
        </Button>
      )}
      <DestructiveConfirm
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel shipment?"
        description="The shipment will be marked cancelled and any reserved stock will be released. Already-shipped or delivered shipments cannot be cancelled."
        confirmLabel="Cancel shipment"
        cancelLabel="Keep shipment"
        pending={busy === 'cancel'}
        onConfirm={cancel}
      />
    </>
  );
}
