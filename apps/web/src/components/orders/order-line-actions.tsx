'use client';

import { describeRaiseAfterPicking, type OrderStatus } from '@stockpilot/core';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { formatNumber } from '@/lib/utils';
import {
  removeOrderRequestLineAction,
  updateOrderRequestLineQuantityAction,
} from '@/server/actions/order-requests';

interface Props {
  orderId: string;
  lineId: string;
  /** Display name for the item on this line ("Deleted item" rows pass a fallback). */
  itemName: string;
  quantityRequested: number;
  /** Units physically handed over at pickup/delivery. Hard floor on a reduction. */
  quantityFulfilled: number;
  /** Units staged by a picker but not yet handed over. Null = never touched. */
  quantityPicked: number | null;
  /**
   * The ORDER's status. Read only to decide whether a raise happens after
   * picking is already finished (SO-000061) — it never gates the edit itself,
   * which the service alone decides.
   */
  orderStatus: OrderStatus | string;
  /** This is the last line on the order — removing it would empty the record. */
  isOnlyLine: boolean;
}

/**
 * Why a quantity the user typed would be refused by
 * OrderRequestsService.updateLineQuantity, or null when it would be accepted.
 *
 * The sentences are the service's own, verbatim. Two copies of a rule always
 * drift, and the drift the user feels is a client that blocks for one reason
 * while the server would have blocked for another — so when this fires the
 * wording is already the wording they would have got from the server.
 *
 * Only REDUCTIONS have floors. Raising is the same act as adding more items,
 * which is allowed for the whole window this control renders in, so nothing
 * here may block it.
 */
export function quantityBlockedReason(input: {
  quantity: number;
  fulfilled: number;
  picked: number | null;
}): string | null {
  const { quantity } = input;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return 'Enter a quantity above zero, or remove the line instead.';
  }
  const fulfilled = Number(input.fulfilled) || 0;
  if (quantity < fulfilled) {
    return `${fulfilled} of these have already been handed over — the quantity can't go below ${fulfilled}.`;
  }
  const picked = Number(input.picked ?? 0) || 0;
  if (quantity < picked) {
    return `${picked} of these are already picked and staged — unstage them or finish fulfilling this line before lowering the quantity below ${picked}.`;
  }
  return null;
}

/**
 * Why OrderRequestsService.removeLine would refuse this line, or null when it
 * would delete it. Same order of checks as the service, so the reason shown is
 * the one the server would have named first.
 *
 * The service's returned_quantity check (R3) has no counterpart here because
 * the order detail doesn't carry that column — and it can't fire on its own
 * anyway: units can only be returned after they were handed over, so any line
 * with returns already trips the handed-over check above it.
 *
 * NOT a blocker: an active stock_reservations row. This mirror used to refuse
 * removal whenever the line's item still held one, on the assumption that a
 * hold implied staged physical stock. It does not — approve_order_request
 * mints a hold for every line at APPROVAL, so that rule made removal
 * impossible from approval onward, and its advice ("unstage the order or
 * regenerate the pick slip") named two steps that release nothing. A
 * reservation is a soft promise; removeLine now RE-SYNCS it (releases or
 * reduces) instead of refusing. What protects physical reality is
 * quantity_picked and quantity_fulfilled, which are the checks that remain.
 */
export function removalBlockedReason(input: {
  fulfilled: number;
  picked: number | null;
  isOnlyLine: boolean;
}): string | null {
  const fulfilled = Number(input.fulfilled) || 0;
  if (fulfilled > 0) {
    return `${fulfilled} of these have already been handed over — this line can't be removed. Lower the quantity instead, or record a return.`;
  }
  const picked = Number(input.picked ?? 0) || 0;
  if (picked > 0) {
    return `${picked} of these are already picked and staged — unstage them first, then remove the line.`;
  }
  if (input.isOnlyLine) {
    return 'This is the only item on the order — cancel the order instead of emptying it.';
  }
  return null;
}

/**
 * Per-line edit controls for the order detail's Lines table (owner request
 * 2026-07-22: "theres no way to delete the item you added if you added the
 * wrong one or edit the amount"). Backed by
 * OrderRequestsService.updateLineQuantity / removeLine.
 *
 * Deliberately NOT optimistic. Every refusal in the service is about physical
 * stock — handed over or staged — and a quantity shown as saved that the
 * server then rejected would send someone to a shelf for units the order never
 * asked for. A brief spinner is the cheaper failure.
 *
 * The caller renders this in a trailing actions cell and is responsible for
 * the gate: it appears only where addLines' gate (requester-or-approver, before
 * the order ships) already lets the Add items button appear, because all three
 * service methods share loadEditableOrderHeader.
 */
export function OrderLineActions({
  orderId,
  lineId,
  itemName,
  quantityRequested,
  quantityFulfilled,
  quantityPicked,
  orderStatus,
  isOnlyLine,
}: Props) {
  const router = useRouter();
  const hintId = React.useId();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(quantityRequested);
  const [saving, setSaving] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [raiseConfirmOpen, setRaiseConfirmOpen] = React.useState(false);

  const blocked = quantityBlockedReason({
    quantity: draft,
    fulfilled: quantityFulfilled,
    picked: quantityPicked,
  });
  /**
   * SO-000061: raising a line AFTER picking finished silently manufactures a
   * shortfall that stays invisible until a signature flips the order to
   * backordered. The permission is correct — a manager may raise it — so this
   * is a warning, never a block. Derived by the shared helper so the phone says
   * the identical sentence. Null on every other edit, which is what keeps the
   * common case (raise before picking, or any reduction) frictionless.
   */
  const raiseWarning = describeRaiseAfterPicking({
    line: {
      quantityRequested,
      quantityFulfilled,
      quantityPicked,
    },
    nextRequested: draft,
    status: orderStatus,
  });
  const unchanged = draft === quantityRequested;
  const removeBlocked = removalBlockedReason({
    fulfilled: quantityFulfilled,
    picked: quantityPicked,
    isOnlyLine,
  });

  function startEditing() {
    setDraft(quantityRequested);
    setEditing(true);
  }

  /**
   * The Save click. Everything except a post-picking raise commits straight
   * away; that one case stops for an explicit confirmation first, because the
   * consequence (someone has to go back to a shelf, and nobody has been told)
   * is invisible from the number the user just typed.
   */
  function requestSave() {
    if (blocked != null || unchanged || saving) return;
    if (raiseWarning != null) {
      setRaiseConfirmOpen(true);
      return;
    }
    void save();
  }

  async function save() {
    if (blocked != null || unchanged) return;
    setSaving(true);
    const res = await updateOrderRequestLineQuantityAction({
      id: orderId,
      lineId,
      quantity: draft,
    });
    setSaving(false);
    if (!res.ok) {
      // The server's sentence, unedited — it names the fulfilled/staged number
      // that made the change impossible, which generic copy would throw away.
      // The editor stays open with the typed number so the user can adjust it.
      toast.error(res.error.message);
      return;
    }
    toast.success(`${itemName} — quantity changed to ${formatNumber(res.data.quantity)}.`);
    warnIfPickSlipStale(res.data.pickSlipStale);
    // Repeated as a toast as well as in the confirmation: the confirmation is
    // gone by now, and the person who has to act on it may not be the person
    // who clicked. The order's own banner carries it from here.
    if (raiseWarning != null) {
      toast.warning(raiseWarning, { duration: 8000 });
    }
    setRaiseConfirmOpen(false);
    setEditing(false);
    router.refresh();
  }

  async function remove() {
    setRemoving(true);
    const res = await removeOrderRequestLineAction({ id: orderId, lineId });
    setRemoving(false);
    if (!res.ok) {
      // Left open on purpose: a refusal here is nearly always a state the
      // viewer didn't know about (someone staged the line in another tab), and
      // it reads better against the item name still on screen.
      toast.error(res.error.message);
      return;
    }
    toast.success(`${itemName} removed from this order.`);
    warnIfPickSlipStale(res.data.pickSlipStale);
    setConfirmOpen(false);
    router.refresh();
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center justify-end gap-1">
          <BlankZeroNumberInput
            value={draft}
            onValueChange={setDraft}
            min={1}
            step={1}
            disabled={saving}
            autoFocus
            className="h-8 w-20 text-right tabular-nums"
            aria-label={`Requested quantity for ${itemName}`}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={`Save quantity for ${itemName}`}
            disabled={saving || unchanged || blocked != null}
            onClick={requestSave}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={`Cancel quantity change for ${itemName}`}
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {blocked && (
          <p className="text-muted-foreground max-w-[15rem] text-right text-[11px] leading-snug">
            {blocked}
          </p>
        )}
        {/* Shown live under the field as well as in the confirmation, so the
            consequence is visible while the number is still being chosen — the
            confirmation is the last chance, not the first mention. Amber, the
            same tone the order's partial-fulfilment and stale-slip banners use
            for "this needs attention but nothing is broken". */}
        {blocked == null && raiseWarning != null && (
          <p className="max-w-[15rem] text-right text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            {raiseWarning}
          </p>
        )}
        <DestructiveConfirm
          open={raiseConfirmOpen}
          onOpenChange={setRaiseConfirmOpen}
          tone="primary"
          title="Raise this quantity anyway?"
          description={raiseWarning ?? ''}
          confirmLabel="Raise the quantity"
          cancelLabel="Leave it as it is"
          pending={saving}
          onConfirm={save}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        aria-label={`Change quantity for ${itemName}`}
        title="Change quantity"
        onClick={startEditing}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {removeBlocked ? (
        // Rendered disabled rather than hidden: a control that silently
        // disappears on some rows reads as a bug, and the reason IS the useful
        // information — it tells the user which real-world step (unstage the
        // picked units, record a return, cancel the order) unblocks them. Every
        // remaining reason names an action the user can actually take, which is
        // exactly what the removed reservation rule could not do. The reason
        // lives on the wrapper because browsers don't fire hover on a disabled
        // button, and is repeated for screen readers via aria-describedby.
        <span title={removeBlocked}>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={`Remove ${itemName}`}
            aria-describedby={hintId}
            disabled
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <span id={hintId} className="sr-only">
            {removeBlocked}
          </span>
        </span>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="text-destructive hover:text-destructive h-8 w-8"
          aria-label={`Remove ${itemName}`}
          title="Remove from order"
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
      <DestructiveConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove this item?"
        description={
          <>
            <span className="text-foreground font-medium">{itemName}</span> comes off this
            order, along with the {formatNumber(quantityRequested)} requested. Nothing has
            been picked or handed over for it, so no stock moves — any stock this order
            was holding for it goes back to available.
          </>
        }
        confirmLabel="Remove item"
        pending={removing}
        onConfirm={remove}
      />
    </div>
  );
}

/**
 * Same warning the add flow raises, worded the same way: a slip printed before
 * the change no longer matches the order, and the person who needs to know is
 * the picker holding the paper.
 */
function warnIfPickSlipStale(stale: boolean) {
  if (!stale) return;
  toast.warning(
    'The printed pick slip is now out of date. Generate it again before picking.',
    { duration: 8000 },
  );
}
