'use client';

import {
  Box,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Loader2,
  PackageCheck,
  Printer,
  Save,
  ScanLine,
  Truck,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  AssignDeliveryDialog,
  type DriverOption,
} from '@/components/orders/assign-delivery-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  approveOrderRequestAction,
  completePickingAction,
  denyOrderRequestAction,
  generatePackingSlipsAction,
  generatePickSlipAction,
  markInTransitAction,
  setOrderInternalNotesAction,
  stageOrderAction,
} from '@/server/actions/order-requests';

import type { OrderRequestStatus } from '@/server/services/order-requests';

interface Props {
  orderId: string;
  status: OrderRequestStatus;
  internalNotes: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  assignedDeliveryUserId: string | null;
  signatureToken: string | null;
  drivers: DriverOption[];
  /** Whether the viewer has orders:approve. Drives which manage-only
   *  sections render. False = staff driver assigned to this delivery
   *  who sees the panel ONLY for in-transit actions; they shouldn't
   *  see Approve / Deny / Reassign / Internal-Notes. */
  canApprove: boolean;
}

type BusyKey =
  | 'approve'
  | 'deny'
  | 'generate-pick-slip'
  | 'complete-picking'
  | 'generate-packing-slips'
  | 'stage-pickup'
  | 'stage-delivery'
  | 'mark-in-transit'
  | 'notes'
  | null;

const DOWNSTREAM_PACKING_STATUSES: OrderRequestStatus[] = [
  'packing_slip_generated',
  'staged_for_pickup',
  'staged_for_delivery',
  'completed',
];

export function ManagerActionsPanel({
  orderId,
  status,
  internalNotes,
  fulfillmentType,
  assignedDeliveryUserId,
  signatureToken,
  drivers,
  canApprove,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<BusyKey>(null);
  const [notes, setNotes] = React.useState(internalNotes ?? '');
  const initialNotes = React.useRef(internalNotes ?? '');

  // Replaces the native window.prompt() that used to collect the
  // denial reason. Native prompt is blocked in iOS Safari webviews,
  // can't be styled, and doesn't handle cancel cleanly. The dialog
  // also captures focus so screen readers announce the action.
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState('');

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
    const reason = denyReason.trim();
    if (!reason) {
      toast.error('Enter a reason before denying.');
      return;
    }
    setBusy('deny');
    const res = await denyOrderRequestAction({ id: orderId, reason });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setDenyOpen(false);
    setDenyReason('');
    toast.success('Request denied.');
    router.refresh();
  }

  async function generatePickSlip() {
    setBusy('generate-pick-slip');
    const res = await generatePickSlipAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Pick slip generated.');
    router.refresh();
  }

  async function completePicking() {
    setBusy('complete-picking');
    const res = await completePickingAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Picking complete.');
    router.refresh();
  }

  async function generatePackingSlips() {
    setBusy('generate-packing-slips');
    const res = await generatePackingSlipsAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Packing slips ready.');
    router.refresh();
  }

  async function stagePickup() {
    setBusy('stage-pickup');
    const res = await stageOrderAction({ id: orderId, target: 'staged_for_pickup' });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Order staged for pickup.');
    router.refresh();
  }

  async function stageDelivery() {
    setBusy('stage-delivery');
    const res = await stageOrderAction({ id: orderId, target: 'staged_for_delivery' });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Order staged for delivery.');
    router.refresh();
  }

  async function markInTransit() {
    setBusy('mark-in-transit');
    const res = await markInTransitAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Order is on the way.');
    router.refresh();
  }

  function collectSignature() {
    if (!signatureToken) {
      toast.error('No signature token on this order — regenerate the packing slip.');
      return;
    }
    window.open(`/orders/sign/${signatureToken}`, '_blank', 'noopener,noreferrer');
  }

  function printPickSlip() {
    window.open(`/api/orders/${orderId}/pick-slip.pdf`, '_blank', 'noopener,noreferrer');
  }

  function printCustomerSlip() {
    window.open(
      `/api/orders/${orderId}/packing-slip-customer.pdf`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  function printWarehouseSlip() {
    window.open(
      `/api/orders/${orderId}/packing-slip-warehouse.pdf`,
      '_blank',
      'noopener,noreferrer',
    );
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

  // eslint-disable-next-line react-hooks/refs -- ref init, not setState
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
          {status === 'pending_approval' && canApprove && (
            <>
              <Button variant="gradient" onClick={approve} disabled={busy !== null}>
                {busy === 'approve' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Approve
              </Button>
              <Button
                variant="destructive"
                onClick={() => setDenyOpen(true)}
                disabled={busy !== null}
              >
                <X className="h-3.5 w-3.5" />
                Deny
              </Button>
            </>
          )}

          {status === 'approved' && (
            <Button
              variant="gradient"
              onClick={generatePickSlip}
              disabled={busy !== null}
            >
              {busy === 'generate-pick-slip' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ClipboardList className="h-3.5 w-3.5" />
              )}
              Generate pick slip
            </Button>
          )}

          {(status === 'pick_slip_generated' || status === 'picking_in_progress') && (
            <>
              <Button variant="gradient" asChild disabled={busy !== null}>
                <Link href={`/dashboard/orders/${orderId}/pick`}>
                  <ScanLine className="h-3.5 w-3.5" />
                  Open digital pick
                </Link>
              </Button>
              <Button
                variant="outline"
                onClick={printPickSlip}
                disabled={busy !== null}
              >
                <Printer className="h-3.5 w-3.5" />
                Print pick slip
              </Button>
              <Button
                variant="outline"
                onClick={completePicking}
                disabled={busy !== null}
              >
                {busy === 'complete-picking' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ClipboardCheck className="h-3.5 w-3.5" />
                )}
                Mark picking complete
              </Button>
            </>
          )}

          {status === 'picking_complete' && (
            <>
              <Button
                variant="gradient"
                onClick={generatePackingSlips}
                disabled={busy !== null}
              >
                {busy === 'generate-packing-slips' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Box className="h-3.5 w-3.5" />
                )}
                Generate packing slips
              </Button>
              <Button
                variant="outline"
                onClick={printPickSlip}
                disabled={busy !== null}
              >
                <Printer className="h-3.5 w-3.5" />
                Print pick slip
              </Button>
            </>
          )}

          {DOWNSTREAM_PACKING_STATUSES.includes(status) && (
            <>
              <Button
                variant="outline"
                onClick={printCustomerSlip}
                disabled={busy !== null}
              >
                <Printer className="h-3.5 w-3.5" />
                Print customer slip
              </Button>
              <Button
                variant="outline"
                onClick={printWarehouseSlip}
                disabled={busy !== null}
              >
                <Printer className="h-3.5 w-3.5" />
                Print warehouse slip
              </Button>
            </>
          )}

          {status === 'packing_slip_generated' && fulfillmentType === 'pickup' && (
            <Button
              variant="default"
              onClick={stagePickup}
              disabled={busy !== null}
            >
              {busy === 'stage-pickup' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PackageCheck className="h-3.5 w-3.5" />
              )}
              Mark staged for pickup
            </Button>
          )}

          {status === 'packing_slip_generated' && fulfillmentType === 'delivery' && (
            <Button
              variant="default"
              onClick={stageDelivery}
              disabled={busy !== null}
            >
              {busy === 'stage-delivery' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PackageCheck className="h-3.5 w-3.5" />
              )}
              Mark staged for delivery
            </Button>
          )}

          {status === 'staged_for_delivery' && canApprove && (
            <AssignDeliveryDialog
              orderId={orderId}
              drivers={drivers}
              currentDriverId={assignedDeliveryUserId}
              trigger={
                <Button variant="default" disabled={busy !== null}>
                  <Truck className="h-3.5 w-3.5" />
                  {assignedDeliveryUserId ? 'Reassign delivery' : 'Assign delivery'}
                </Button>
              }
            />
          )}

          {status === 'staged_for_delivery' && assignedDeliveryUserId && (
            <Button
              variant="default"
              onClick={markInTransit}
              disabled={busy !== null}
            >
              {busy === 'mark-in-transit' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Truck className="h-3.5 w-3.5" />
              )}
              Mark in transit
            </Button>
          )}

          {(status === 'staged_for_pickup' || status === 'in_transit') && (
            <Button
              variant="gradient"
              onClick={collectSignature}
              disabled={busy !== null || !signatureToken}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Collect signature
            </Button>
          )}

          {(status === 'completed' || status === 'denied' || status === 'cancelled') && (
            <div className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5" />
              No further actions — this request is in a terminal state.
            </div>
          )}
        </div>

        {canApprove && (
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
        )}
      </div>

      {/* Deny-reason dialog. Replaces the old window.prompt() which
          was blocked in iOS Safari webviews and couldn't be styled. */}
      <Dialog
        open={denyOpen}
        onOpenChange={(v) => {
          if (busy === 'deny') return;
          setDenyOpen(v);
          if (!v) setDenyReason('');
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Deny this request?</DialogTitle>
            <DialogDescription>
              The requester will be notified with the reason you provide.
              This action can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="deny-reason">Reason</Label>
            <Textarea
              id="deny-reason"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Brief explanation the requester will see"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDenyOpen(false)}
              disabled={busy === 'deny'}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={deny}
              disabled={busy === 'deny' || !denyReason.trim()}
            >
              {busy === 'deny' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Deny request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
