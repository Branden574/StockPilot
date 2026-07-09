'use client';

import {
  Box,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Hand,
  Loader2,
  PackageCheck,
  PackageX,
  PenLine,
  Printer,
  RotateCcw,
  Save,
  ScanLine,
  Truck,
  Unlock,
  User,
  UserCog,
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
import { AssignPickerDialog } from '@/components/orders/assign-picker-dialog';
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
  approveOrderPartialAction,
  approveOrderRequestAction,
  claimPickingAction,
  closePartialAction,
  completePickingAction,
  denyOrderRequestAction,
  generatePackingSlipsAction,
  generatePickSlipAction,
  markInTransitAction,
  releasePickingAction,
  resumeFulfillmentAction,
  setOrderInternalNotesAction,
  stageOrderAction,
} from '@/server/actions/order-requests';
import { availableOrderActions, derivePickingStatus, type Role } from '@stockpilot/core';

import type { OrderRequestStatus } from '@/server/services/order-requests';

interface Props {
  orderId: string;
  status: OrderRequestStatus;
  internalNotes: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  assignedDeliveryUserId: string | null;
  signatureToken: string | null;
  /** Whether a signature exists — drives the "View signature" button. The
   *  actual data-URL blob is fetched lazily on dialog-open (see the sig
   *  dialog) instead of shipped in the RSC payload. */
  hasSignature: boolean;
  signedByName: string | null;
  signedAt: string | null;
  drivers: DriverOption[];
  /** Whether the viewer has orders:approve. Drives which manage-only
   *  sections render. False = staff driver assigned to this delivery
   *  who sees the panel ONLY for in-transit actions; they shouldn't
   *  see Approve / Deny / Reassign / Internal-Notes. */
  canApprove: boolean;
  /** Whether a strict approve would fall short of the requested qty. Drives the
   *  "Approve partial" affordance at pending_approval (server-computed). */
  isShortStock?: boolean;
  /** Picking claim/lock context. The shared state machine
   *  (`availableOrderActions`) reads these to decide which of
   *  claim / reassign / release / pick / complete render for THIS
   *  viewer at the picking statuses. */
  viewerRole: Role;
  viewerUserId: string;
  assignedPickerId: string | null;
  /** Resolved display name for `assignedPickerId`, or null. Drives the
   *  "Being picked by {name}" chip. */
  assignedPickerName: string | null;
  /** Candidate pickers for the AssignPickerDialog (manager+ only; empty
   *  otherwise). Same active-members shape as `drivers`. */
  pickers: DriverOption[];
  /** Whether THIS viewer can actually pick this order — i.e. holds the pick
   *  permission (manager+ or items:update) AND has write access to the order's
   *  warehouse. The server computes it and the shared state machine reads it so
   *  the picking phase offers only view/print (never Claim/Pick/Complete/
   *  Release) to a viewer the backend would reject. */
  viewerCanPick: boolean;
}

type BusyKey =
  | 'approve'
  | 'approve-partial'
  | 'deny'
  | 'generate-pick-slip'
  | 'claim-picking'
  | 'release-picking'
  | 'complete-picking'
  | 'generate-packing-slips'
  | 'stage-pickup'
  | 'stage-delivery'
  | 'mark-in-transit'
  | 'resume-fulfillment'
  | 'close-partial'
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
  hasSignature,
  signedByName,
  signedAt,
  drivers,
  canApprove,
  isShortStock,
  viewerRole,
  viewerUserId,
  assignedPickerId,
  assignedPickerName,
  pickers,
  viewerCanPick,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<BusyKey>(null);

  // Single source of truth for which picking affordances THIS viewer gets.
  // Never branch on status/role for picking here — read the shared machine.
  const actions = availableOrderActions({
    status,
    fulfillmentType,
    hasAssignedDelivery: assignedDeliveryUserId !== null,
    viewerRole,
    viewerUserId,
    assignedPickerId,
    assignedDeliveryUserId,
    viewerCanPick,
    isShortStock,
  });
  const isPickingPhase =
    status === 'pick_slip_generated' || status === 'picking_in_progress';
  const pickingStatus = derivePickingStatus(status, assignedPickerId);
  const [sigOpen, setSigOpen] = React.useState(false);
  // Signature blob is fetched on first dialog-open, then cached for the mount.
  const [sigUrl, setSigUrl] = React.useState<string | null>(null);
  const [sigLoading, setSigLoading] = React.useState(false);

  React.useEffect(() => {
    // NOTE: `sigLoading` must NOT be a dependency here — setting it below
    // would re-run the effect, whose cleanup cancels the in-flight fetch, so
    // the spinner would hang forever. The `sigUrl` guard prevents a re-fetch
    // after success.
    if (!sigOpen || sigUrl) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setSigLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/orders/${orderId}/signature`, {
          credentials: 'same-origin',
        });
        const data = (await res.json()) as { signatureDataUrl?: string | null };
        if (!cancelled) setSigUrl(data.signatureDataUrl ?? null);
      } catch {
        /* leave null — dialog shows the "no signature" fallback */
      } finally {
        if (!cancelled) setSigLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sigOpen, sigUrl, orderId]);
  const [notes, setNotes] = React.useState(internalNotes ?? '');
  const initialNotes = React.useRef(internalNotes ?? '');

  // Replaces the native window.prompt() that used to collect the
  // denial reason. Native prompt is blocked in iOS Safari webviews,
  // can't be styled, and doesn't handle cancel cleanly. The dialog
  // also captures focus so screen readers announce the action.
  const [denyOpen, setDenyOpen] = React.useState(false);
  const [denyReason, setDenyReason] = React.useState('');
  const [closePartialOpen, setClosePartialOpen] = React.useState(false);

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

  async function approvePartial() {
    setBusy('approve-partial');
    const res = await approveOrderPartialAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Approved — available stock reserved, the rest will backorder.');
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

  async function claimPicking() {
    setBusy('claim-picking');
    const res = await claimPickingAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('You claimed picking for this order.');
    router.refresh();
  }

  async function releasePicking() {
    setBusy('release-picking');
    const res = await releasePickingAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Picking released.');
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

  async function resumeFulfillment() {
    setBusy('resume-fulfillment');
    const res = await resumeFulfillmentAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Fulfillment resumed — a new pick slip is ready for the remaining items.');
    router.refresh();
  }

  async function closePartial() {
    setBusy('close-partial');
    const res = await closePartialAction({ id: orderId });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setClosePartialOpen(false);
    toast.success('Order closed as delivered-partial.');
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
              {actions.includes('approve_partial') && (
                <Button
                  variant="outline"
                  onClick={approvePartial}
                  disabled={busy !== null}
                >
                  {busy === 'approve-partial' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PackageCheck className="h-3.5 w-3.5" />
                  )}
                  Approve partial
                </Button>
              )}
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

          {isPickingPhase && (
            <>
              {/* Picker lock chip — full-row so it sits above the buttons. */}
              <span className="text-muted-foreground inline-flex w-full items-center gap-1.5 text-[11.5px]">
                <User className="h-3.5 w-3.5" />
                {pickingStatus === 'unassigned'
                  ? 'Unassigned'
                  : `Being picked by ${assignedPickerName ?? 'someone'}`}
              </span>

              {actions.includes('claim_picking') && (
                <Button
                  variant="gradient"
                  onClick={claimPicking}
                  disabled={busy !== null}
                >
                  {busy === 'claim-picking' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Hand className="h-3.5 w-3.5" />
                  )}
                  Claim picking
                </Button>
              )}

              {actions.includes('open_digital_pick') && (
                <Button variant="gradient" asChild disabled={busy !== null}>
                  <Link href={`/dashboard/orders/${orderId}/pick`}>
                    <ScanLine className="h-3.5 w-3.5" />
                    Open digital pick
                  </Link>
                </Button>
              )}

              <Button
                variant="outline"
                onClick={printPickSlip}
                disabled={busy !== null}
              >
                <Printer className="h-3.5 w-3.5" />
                Print pick slip
              </Button>

              {actions.includes('mark_picking_complete') && (
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
              )}

              {actions.includes('reassign_picker') && (
                <AssignPickerDialog
                  orderId={orderId}
                  pickers={pickers}
                  currentPickerId={assignedPickerId}
                  trigger={
                    <Button variant="default" disabled={busy !== null}>
                      <UserCog className="h-3.5 w-3.5" />
                      {assignedPickerId ? 'Reassign picker' : 'Assign picker'}
                    </Button>
                  }
                />
              )}

              {actions.includes('release_picking') && (
                <Button
                  variant="outline"
                  onClick={releasePicking}
                  disabled={busy !== null}
                >
                  {busy === 'release-picking' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Unlock className="h-3.5 w-3.5" />
                  )}
                  Release
                </Button>
              )}
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
              {hasSignature && (
                <Button
                  variant="outline"
                  onClick={() => setSigOpen(true)}
                  disabled={busy !== null}
                >
                  <PenLine className="h-3.5 w-3.5" />
                  View signature
                </Button>
              )}
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

          {status === 'backordered' && canApprove && (
            <>
              <Button
                variant="gradient"
                onClick={resumeFulfillment}
                disabled={busy !== null}
              >
                {busy === 'resume-fulfillment' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                Resume fulfillment
              </Button>
              <Button
                variant="outline"
                onClick={() => setClosePartialOpen(true)}
                disabled={busy !== null}
              >
                <PackageX className="h-3.5 w-3.5" />
                Close as delivered-partial
              </Button>
            </>
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

      {/* Close-as-delivered-partial confirm */}
      <Dialog
        open={closePartialOpen}
        onOpenChange={(v) => {
          if (busy === 'close-partial') return;
          setClosePartialOpen(v);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close as delivered-partial?</DialogTitle>
            <DialogDescription>
              This ends the order and keeps the record of what was already
              delivered. The remaining backordered units will NOT be fulfilled.
              You can&apos;t reopen the order afterward.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClosePartialOpen(false)}
              disabled={busy === 'close-partial'}
            >
              Cancel
            </Button>
            <Button variant="gradient" onClick={closePartial} disabled={busy === 'close-partial'}>
              {busy === 'close-partial' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Close order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View signature */}
      <Dialog open={sigOpen} onOpenChange={setSigOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Customer signature</DialogTitle>
            <DialogDescription>
              {signedByName ? `Signed by ${signedByName}` : 'Signed'}
              {signedAt
                ? ` · ${new Date(signedAt).toLocaleString()}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {sigLoading ? (
            <div className="grid h-40 place-items-center">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : sigUrl ? (
            <div className="rounded-md border bg-white p-3">
              {/* Signatures are dark ink on a transparent background, so they
                  vanish on a dark card — always back them with white. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sigUrl}
                alt="Customer signature"
                className="mx-auto max-h-64 w-full object-contain"
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No signature on file.</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSigOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
