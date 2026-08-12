'use client';

import { describeNewRackPlacement } from '@stockpilot/core';
import { AlertTriangle, Loader2, PackageCheck } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DestinationOption } from '@/lib/locations/destination-option';
import { placeStockAction } from '@/server/actions/inventory';

const NEW_RACK_SENTINEL = '__new__';

interface PlaceFromStagingDialogProps {
  itemId: string;
  itemName: string;
  itemType: string;
  /** The not-yet-placed holding location to move stock OUT of (staging or unplaced). */
  sourceLocationId: string;
  /** Drives the "From" label + copy. 'unplaced' = on-hand stock that was never racked. */
  sourceKind: 'staging' | 'unplaced';
  warehouseId: string;
  /** Warehouse display name — shown in the new-rack confirmation copy. */
  warehouseName?: string;
  /** Quantity sitting in the source holding (the placement ceiling). */
  availableQuantity: number;
  destinations: DestinationOption[];
  trigger?: React.ReactNode;
}

export function PlaceFromStagingDialog({
  itemId,
  itemName,
  itemType,
  sourceLocationId,
  sourceKind,
  warehouseId,
  warehouseName,
  availableQuantity,
  destinations,
  trigger,
}: PlaceFromStagingDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const sourceLabel = sourceKind === 'unplaced' ? 'Unplaced' : 'Staging';

  const [destId, setDestId] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState(String(availableQuantity));
  const [notes, setNotes] = React.useState('');

  // Inline new-rack/crate fields
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);
  // When the chosen "+ New rack/crate" does NOT already exist in this warehouse,
  // we pause on a confirmation before creating it — the 2026-07-23 guard. Null
  // means no pending confirmation (the common path, an existing destination,
  // never sets it). Holds the exact copy + one-tap near-match alternatives.
  const [pendingNewRack, setPendingNewRack] = React.useState<{
    title: string;
    message: string;
    suggestions: string[];
  } | null>(null);
  // Server failures render inline (persistent) as well as via toast — same
  // rationale as StockTransferDialog: a toast alone auto-dismisses outside
  // the modal and a rejected submit can read as "nothing happened".
  const [serverError, setServerError] = React.useState<string | null>(null);

  const isBook = itemType === 'book';
  const isNew = destId === NEW_RACK_SENTINEL;

  // Reset form state whenever the dialog opens
  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset all fields when dialog opens */
    setDestId('');
    setQuantity(String(availableQuantity));
    setNotes('');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setServerError(null);
    setPendingNewRack(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any edit to the destination/quantity invalidates a pending confirmation —
  // its copy names a specific label and count, so it must not outlive the inputs
  // it described. Cheap to recompute: hitting Place re-derives it.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale confirmation on edit
    setPendingNewRack(null);
  }, [destId, rackNumber, rackRow, crateColor, crateNumber, quantity]);

  const qtyNum = Number.parseInt(quantity, 10);
  const qtyValid = Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= availableQuantity;

  const canSubmit =
    !submitting &&
    qtyValid &&
    (isNew ? rackNumber.trim().length > 0 : destId.length > 0);

  // Run the placement. Split out from the gate below so the confirmation step
  // and the "Did you mean…" one-tap alternatives share ONE write path.
  async function place(destination: Parameters<typeof placeStockAction>[0]['destination']) {
    setSubmitting(true);
    setServerError(null);
    const res = await placeStockAction({
      itemId,
      fromLocationId: sourceLocationId,
      quantity: qtyNum,
      notes: notes.trim() || undefined,
      destination,
    });
    setSubmitting(false);

    if (!res.ok) {
      setServerError(res.error.message);
      toast.error(res.error.message);
      return;
    }

    toast.success(`Placed ${qtyNum} ${qtyNum === 1 ? 'unit' : 'units'} of ${itemName}.`);
    setOpen(false);
    router.refresh();
  }

  function submit() {
    if (!qtyValid) {
      toast.error(`Quantity must be between 1 and ${availableQuantity}.`);
      return;
    }

    if (!isNew) {
      if (!destId) {
        toast.error('Select a destination location.');
        return;
      }
      void place({ existingLocationId: destId });
      return;
    }

    if (!rackNumber.trim()) {
      toast.error('Enter a rack number.');
      return;
    }

    // The chosen destination is a rack/crate typed inline. Before creating it we
    // ask whether it is genuinely new — the 2026-07-23 guard against a slipped
    // keystroke minting a rack. describeNewRackPlacement checks the label against
    // this warehouse's EXISTING rack/crate names (findOrCreateRackOrCrate reuses
    // a name match, so an existing label is not a creation and needs no
    // confirmation — zero friction on the common path).
    const isCrate = isBook && crateColor.trim().length > 0;
    const label = isCrate
      ? `${crateColor.trim()} #${crateNumber.trim() || rackNumber.trim()}`
      : rackRow.trim()
        ? `${rackNumber.trim()}-${rackRow.trim()}`
        : rackNumber.trim();
    const decision = describeNewRackPlacement({
      label,
      warehouseName,
      quantity: qtyNum,
      existingLabels: destinations.map((d) => d.name),
      noun: isCrate ? 'crate' : 'rack',
    });

    const destination = {
      newRack: {
        warehouseId,
        rackNumber: rackNumber.trim(),
        ...(rackRow.trim() ? { rackRow: rackRow.trim() } : {}),
        ...(isBook && crateColor.trim() ? { crateColor: crateColor.trim() } : {}),
        ...(isBook && crateNumber.trim() ? { crateNumber: crateNumber.trim() } : {}),
      },
    } satisfies Parameters<typeof placeStockAction>[0]['destination'];

    if (decision.exists) {
      // Typed the name of a rack that already exists — the server will reuse it,
      // nothing is created, so proceed without a confirmation.
      void place(destination);
      return;
    }

    setPendingNewRack({
      title: decision.title,
      message: decision.message,
      suggestions: decision.suggestions,
    });
  }

  // "Did you mean 10-A?" — place into the EXISTING rack the worker probably
  // meant, instead of creating the typo. The suggestion is an existing label,
  // so map it back to that destination's id and take the existing-location path.
  function placeIntoSuggestion(label: string) {
    const match = destinations.find(
      (d) => d.name.trim().toLowerCase() === label.trim().toLowerCase(),
    );
    if (!match) return;
    setPendingNewRack(null);
    void place({ existingLocationId: match.id });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <PackageCheck className="h-4 w-4" />
            Place
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Place from {sourceLabel.toLowerCase()}</DialogTitle>
          <DialogDescription>
            Move <span className="font-medium text-foreground">{itemName}</span> from{' '}
            {sourceLabel.toLowerCase()} into a rack or crate. Available:{' '}
            <span className="tabular-nums">{availableQuantity}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Fixed source */}
          <div className="space-y-1.5">
            <Label>From</Label>
            <div className="bg-muted text-muted-foreground flex h-9 items-center rounded-md border px-3 text-sm">
              {sourceLabel}
            </div>
          </div>

          {/* Destination picker */}
          <div className="space-y-1.5">
            <Label>To location</Label>
            <Select value={destId} onValueChange={setDestId}>
              <SelectTrigger>
                <SelectValue placeholder="Select destination" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_RACK_SENTINEL}>+ New rack / crate</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Inline new rack/crate inputs */}
          {isNew && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>
                    Rack number <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    placeholder="e.g. A1"
                    value={rackNumber}
                    onChange={(e) => setRackNumber(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Row (optional)</Label>
                  <Input
                    placeholder="e.g. Row 3"
                    value={rackRow}
                    onChange={(e) => setRackRow(e.target.value)}
                  />
                </div>
              </div>

              {isBook && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Crate color (optional)</Label>
                    <Input
                      placeholder="e.g. Blue"
                      value={crateColor}
                      onChange={(e) => setCrateColor(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Crate number (optional)</Label>
                    <Input
                      placeholder="e.g. 42"
                      value={crateNumber}
                      onChange={(e) => setCrateNumber(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Quantity — supports split */}
          <div className="space-y-1.5">
            <Label>
              Quantity{' '}
              <span className="text-muted-foreground font-normal">
                (max {availableQuantity})
              </span>
            </Label>
            <Input
              type="number"
              step="1"
              min="1"
              max={availableQuantity}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {quantity !== '' && !qtyValid && (
              <p className="text-destructive text-[11px]">
                Must be between 1 and {availableQuantity}.
              </p>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              value={notes}
              maxLength={2000}
              placeholder="Reason for placement…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {pendingNewRack && (
          <div
            role="alertdialog"
            aria-label={pendingNewRack.title}
            className="border-amber-500/40 bg-amber-500/10 space-y-2 rounded-md border p-3"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="text-amber-600 dark:text-amber-500 h-4 w-4 shrink-0" />
              <p className="text-sm font-medium">{pendingNewRack.title}</p>
            </div>
            <p className="text-muted-foreground text-sm">{pendingNewRack.message}</p>
            {pendingNewRack.suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-0.5">
                {pendingNewRack.suggestions.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant="outline"
                    disabled={submitting}
                    onClick={() => placeIntoSuggestion(s)}
                  >
                    Use {s} instead
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <DialogFooter>
          {pendingNewRack ? (
            <>
              <Button
                variant="outline"
                onClick={() => setPendingNewRack(null)}
                disabled={submitting}
              >
                Back
              </Button>
              <Button
                onClick={() =>
                  void place({
                    newRack: {
                      warehouseId,
                      rackNumber: rackNumber.trim(),
                      ...(rackRow.trim() ? { rackRow: rackRow.trim() } : {}),
                      ...(isBook && crateColor.trim() ? { crateColor: crateColor.trim() } : {}),
                      ...(isBook && crateNumber.trim() ? { crateNumber: crateNumber.trim() } : {}),
                    },
                  })
                }
                disabled={submitting}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create and place'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!canSubmit}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Place stock'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
