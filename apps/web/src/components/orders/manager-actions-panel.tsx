'use client';

import { Check, CheckCircle2, Loader2, PackageCheck, PackageOpen, Save, Truck, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  approveOrderRequestAction,
  denyOrderRequestAction,
  markOrderRequestDeliveredAction,
  setOrderInternalNotesAction,
  setOrderRequestStatusAction,
} from '@/server/actions/order-requests';

import type { OrderRequestStatus } from '@/server/services/order-requests';

interface Props {
  orderId: string;
  status: OrderRequestStatus;
  internalNotes: string | null;
}

type BusyKey =
  | 'approve'
  | 'deny'
  | 'packing_slip_generated'
  | 'staged_for_delivery'
  | 'completed'
  | 'notes'
  | null;

export function ManagerActionsPanel({ orderId, status, internalNotes }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<BusyKey>(null);
  const [notes, setNotes] = React.useState(internalNotes ?? '');
  const initialNotes = React.useRef(internalNotes ?? '');
  const [deliverOpen, setDeliverOpen] = React.useState(false);

  async function approve() {
    setBusy('approve');
    const res = await approveOrderRequestAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Request approved. Stock reserved.');
    router.refresh();
  }

  async function deny() {
    const reason = window.prompt('Reason for denial?')?.trim();
    if (!reason) return;
    setBusy('deny');
    const res = await denyOrderRequestAction({ id: orderId, reason });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Request denied.');
    router.refresh();
  }

  async function moveTo(next: 'packing_slip_generated' | 'staged_for_delivery') {
    setBusy(next);
    const res = await setOrderRequestStatusAction({ id: orderId, status: next });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      next === 'packing_slip_generated'
        ? 'Marked as packaging.'
        : 'Marked as ready for delivery.',
    );
    router.refresh();
  }

  async function confirmDeliver() {
    setBusy('completed');
    const res = await markOrderRequestDeliveredAction(orderId);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setDeliverOpen(false);
    toast.success('Marked as delivered. Inventory updated.');
    router.refresh();
  }

  async function saveNotes() {
    setBusy('notes');
    const res = await setOrderInternalNotesAction({
      id: orderId,
      notes: notes.trim() ? notes : null,
    });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    initialNotes.current = notes;
    toast.success('Internal notes saved.');
    router.refresh();
  }

  const dirty = notes !== initialNotes.current;

  return (
    <section className="bg-card rounded-xl border">
      <div className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-medium">Manager actions</h2>
        <p className="text-muted-foreground mt-0.5 text-[11.5px]">
          Move this request through the fulfillment pipeline.
        </p>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2">
          {status === 'pending_approval' && (
            <>
              <Button variant="gradient" onClick={approve} disabled={busy !== null}>
                {busy === 'approve' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Approve
              </Button>
              <Button variant="destructive" onClick={deny} disabled={busy !== null}>
                {busy === 'deny' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Deny
              </Button>
            </>
          )}

          {status === 'approved' && (
            <Button
              variant="gradient"
              onClick={() => moveTo('packing_slip_generated')}
              disabled={busy !== null}
            >
              {busy === 'packing_slip_generated' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PackageOpen className="h-3.5 w-3.5" />
              )}
              Mark packaging
            </Button>
          )}

          {status === 'packing_slip_generated' && (
            <Button
              variant="gradient"
              onClick={() => moveTo('staged_for_delivery')}
              disabled={busy !== null}
            >
              {busy === 'staged_for_delivery' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PackageCheck className="h-3.5 w-3.5" />
              )}
              Mark ready
            </Button>
          )}

          {(status === 'approved' ||
            status === 'packing_slip_generated' ||
            status === 'staged_for_delivery') && (
            <Button
              variant="outline"
              onClick={() => setDeliverOpen(true)}
              disabled={busy !== null}
            >
              {busy === 'completed' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Truck className="h-3.5 w-3.5" />
              )}
              Mark delivered
            </Button>
          )}

          {(status === 'completed' || status === 'denied' || status === 'cancelled') && (
            <div className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" />
              No further actions — this request is in a terminal state.
            </div>
          )}
        </div>

        <div className="space-y-1.5 pt-2">
          <Label htmlFor="internal-notes" className="text-xs">
            Internal notes
          </Label>
          <Textarea
            id="internal-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Notes only managers can see"
            disabled={busy === 'notes'}
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={saveNotes}
              disabled={!dirty || busy !== null}
            >
              {busy === 'notes' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save notes
            </Button>
          </div>
        </div>
      </div>

      <DestructiveConfirm
        open={deliverOpen}
        onOpenChange={setDeliverOpen}
        title="Mark delivered?"
        description="Stock is deducted from inventory and any reservations on this order are released. This is the final fulfillment step and cannot be reversed — create a corrective adjustment afterwards if the deduction was wrong."
        confirmLabel="Mark delivered"
        pending={busy === 'completed'}
        onConfirm={confirmDeliver}
      />
    </section>
  );
}
