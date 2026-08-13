'use client';

import { Loader2, PackageMinus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { removeStockFromLocationAction } from '@/server/actions/inventory';

import { formatStockQuantity } from '@stockpilot/core';

interface RemoveFromRackDialogProps {
  itemId: string;
  itemName: string;
  /** The specific holding being drawn down. */
  locationId: string;
  locationName: string;
  /** Units currently in THIS location — the cap and the default. */
  holdingQuantity: number;
  trigger: React.ReactNode;
}

/**
 * Remove (write off) stock from ONE rack, leaving the item's stock in every
 * other rack untouched — the tool Andrew reached for when he archived a whole
 * book to clear one rack (2026-07-23). It is NOT archive: it draws down a single
 * location through removeStockFromLocationAction → adjustStock, writing a proper
 * movement so the history reads truthfully.
 *
 * A reason is MANDATORY (owner ask), the quantity defaults to the whole holding
 * and is capped there, and Remove is disabled until both are valid — so the
 * server's guards are never the first line of defence a normal user hits.
 */
export function RemoveFromRackDialog({
  itemId,
  itemName,
  locationId,
  locationName,
  holdingQuantity,
  trigger,
}: RemoveFromRackDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [quantity, setQuantity] = React.useState(String(holdingQuantity));
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  // Re-seed the whole-holding default and clear the reason each time it opens,
  // so a prior partial removal never leaves stale values in the form.
  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open
    setQuantity(String(holdingQuantity));
    setReason('');
  }, [open, holdingQuantity]);

  const qtyNum = Number(quantity);
  const qtyValid = Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= holdingQuantity;
  const canSubmit = !submitting && qtyValid && reason.trim().length > 0;

  async function submit() {
    if (!reason.trim()) {
      toast.error('Enter a reason for removing this stock.');
      return;
    }
    if (!qtyValid) {
      toast.error(`Quantity must be between 1 and ${formatStockQuantity(holdingQuantity)}.`);
      return;
    }
    setSubmitting(true);
    const res = await removeStockFromLocationAction({
      itemId,
      locationId,
      quantity: qtyNum,
      reason: reason.trim(),
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      `Removed ${formatStockQuantity(qtyNum)} from ${locationName}.`,
    );
    // The stock genuinely left in every one of these cases; they say what
    // happened to the book's crate LABEL. Reported the same way, and in the
    // same order, as the place / put-away dialogs report them — a bare "Removed
    // 40 from Blue #4" next to a summary still naming Blue 4 is exactly the
    // empty crate the picker walks to. The last line is the opposite debt: the
    // label DID move, and the operator only asked to remove stock.
    //
    // ALL FIVE ARE WARNINGS, including that last one. The reconciliation itself
    // is right — the summary is derived from the holdings, and there is no
    // destination here to prompt about — but "Blue 4" is a value a human typed
    // on a crate, and the app replacing it with "Red 7" unasked is a caution,
    // not good news. It read as a green toast while all four of its neighbours
    // warned, which made the one outcome that CHANGED the operator's data the
    // only one that looked like nothing had happened.
    if (res.data.crateSyncFailed) {
      toast.warning(
        `The crate label on ${itemName} could not be updated — check the book’s details.`,
      );
    } else if (res.data.crateSyncStale) {
      toast.warning(
        `Someone else changed the crate on ${itemName} while the stock was being removed — its label was left as they set it.`,
      );
    } else if (res.data.crateSyncUnplaced) {
      toast.warning(
        `${itemName} has no stock in a rack or crate now — its crate label was left unchanged and may be wrong.`,
      );
    } else if (res.data.crateSyncSkipped) {
      toast.warning(
        `${itemName} still has stock in more than one location, so its crate label was left unchanged.`,
      );
    } else if (res.data.crateSyncUpdated) {
      toast.warning(
        `The crate label on ${itemName} was changed to follow the stock it has left.`,
      );
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove stock from {locationName}</DialogTitle>
          <DialogDescription>
            Writes off stock from this one rack. {itemName}&apos;s stock in every other rack is left
            untouched, and this is recorded in the item&apos;s history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="remove-qty">
              Quantity to remove <span className="text-destructive">*</span>
            </Label>
            <Input
              id="remove-qty"
              type="number"
              min={1}
              max={holdingQuantity}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {formatStockQuantity(holdingQuantity)} in {locationName}.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="remove-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="remove-reason"
              rows={2}
              maxLength={500}
              value={reason}
              placeholder="e.g. Damaged in storage, cycle-count correction, written off"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <PackageMinus className="h-4 w-4" /> Remove stock
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
