'use client';

import {
  describeBookCrateChange,
  describeNewRackPlacement,
  parseBookCrateChangeDetail,
  type BookStorageInfo,
} from '@stockpilot/core';
import { Loader2, PackageCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  CrateColorSelect,
  CrateNumberInput,
  CurrentStorageSummary,
  DestinationCrateNote,
  DestinationKindToggle,
  NO_CRATE_COLOR,
  type NewDestinationKind,
} from '@/components/inventory/crate-fields';
import {
  PlacementConfirmDialog,
  type PlacementConfirmContent,
} from '@/components/inventory/placement-confirm-dialog';
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
import {
  destinationCrate,
  destinationLabel,
  destinationPhrase,
  isCrateChoice,
  type ChosenDestination,
} from '@/lib/locations/placement-destination';
import { placeStockAction } from '@/server/actions/inventory';

const NEW_RACK_SENTINEL = '__new__';

type ActionDestination = Parameters<typeof placeStockAction>[0]['destination'];

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
  /**
   * A BOOK's recorded rack/crate SUMMARY, or null for a non-book. Shown as
   * context and used to PREDICT the server's confirmation gate locally, so the
   * question is asked before the submit rather than after it. Never authority:
   * the server re-reads the item before it writes.
   */
  bookStorage?: BookStorageInfo | null;
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
  bookStorage,
  trigger,
}: PlaceFromStagingDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const sourceLabel = sourceKind === 'unplaced' ? 'Unplaced' : 'Staging';

  const [destId, setDestId] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState(String(availableQuantity));
  const [notes, setNotes] = React.useState('');

  // Inline "+ New" fields. `newKind` is now an EXPLICIT choice — typing a crate
  // color used to be the only thing that made a destination a crate, which
  // meant the field deciding locations.kind was never actually asked about.
  const [newKind, setNewKind] = React.useState<NewDestinationKind>('rack');
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);
  // ONE pending confirmation, whatever it has to ask about — a genuinely new
  // rack/crate (the 2026-07-23 typo guard), an overwrite of the book's
  // recorded crate (the server's gate, predicted locally), or both at once.
  // Null on the common path, which stays exactly as fast as it was.
  const [pendingConfirm, setPendingConfirm] = React.useState<{
    content: PlacementConfirmContent;
    destination: ActionDestination;
    acknowledgeCrateChange: boolean;
  } | null>(null);
  // Server failures render inline (persistent) as well as via toast — same
  // rationale as StockTransferDialog: a toast alone auto-dismisses outside
  // the modal and a rejected submit can read as "nothing happened".
  const [serverError, setServerError] = React.useState<string | null>(null);

  const isBook = itemType === 'book';
  const isNew = destId === NEW_RACK_SENTINEL;
  const selectedDestination = destinations.find((d) => d.id === destId) ?? null;

  // Reset form state whenever the dialog opens
  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset all fields when dialog opens */
    setDestId('');
    setQuantity(String(availableQuantity));
    setNotes('');
    setNewKind('rack');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setServerError(null);
    setPendingConfirm(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any edit to the destination/quantity invalidates a pending confirmation —
  // its copy names a specific label and count, so it must not outlive the inputs
  // it described. Cheap to recompute: hitting Place re-derives it.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale confirmation on edit
    setPendingConfirm(null);
  }, [destId, newKind, rackNumber, rackRow, crateColor, crateNumber, quantity]);

  const qtyNum = Number.parseInt(quantity, 10);
  const qtyValid = Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= availableQuantity;

  const newFieldsFilled =
    newKind === 'rack' ? rackNumber.trim().length > 0 : crateNumber.trim().length > 0;
  const canSubmit = !submitting && qtyValid && (isNew ? newFieldsFilled : destId.length > 0);

  /** The destination as chosen in this form — the input to every derivation. */
  function chosenDestination(): ChosenDestination | null {
    if (isNew) {
      return newKind === 'crate'
        ? { mode: 'new-crate', crateColor, crateNumber }
        : { mode: 'new-rack', rackNumber, rackRow };
    }
    return selectedDestination ? { mode: 'existing', option: selectedDestination } : null;
  }

  function toActionDestination(dest: ChosenDestination): ActionDestination {
    if (dest.mode === 'existing') return { existingLocationId: dest.option.id };
    if (dest.mode === 'new-crate') {
      // NO rackNumber. A crate is identified by its NUMBER; sending a rack
      // number as well is what used to make a crate resolve as a rack.
      return {
        newRack: {
          warehouseId,
          crateNumber: dest.crateNumber.trim(),
          ...(dest.crateColor.trim() ? { crateColor: dest.crateColor.trim() } : {}),
        },
      };
    }
    return {
      newRack: {
        warehouseId,
        rackNumber: dest.rackNumber.trim(),
        ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
      },
    };
  }

  // Run the placement. Split out from the gate below so the confirmation step
  // and the "Did you mean…" one-tap alternatives share ONE write path.
  async function place(
    destination: ActionDestination,
    opts: { acknowledgeCrateChange?: boolean; describe?: ChosenDestination } = {},
  ) {
    setSubmitting(true);
    setServerError(null);
    const res = await placeStockAction({
      itemId,
      fromLocationId: sourceLocationId,
      quantity: qtyNum,
      notes: notes.trim() || undefined,
      destination,
      ...(opts.acknowledgeCrateChange ? { acknowledgeCrateChange: true } : {}),
    });
    setSubmitting(false);

    if (!res.ok) {
      // The server refused because this placement overwrites a crate a human
      // recorded. Our local prediction can be stale (the row may have changed
      // since the page rendered, and a non-Staging surface may not predict at
      // all), so the refusal is rendered from ITS payload and retried with the
      // acknowledgement. Only ever asked once: if we already acknowledged and
      // it still refuses, that is a real error.
      const detail = parseBookCrateChangeDetail(res.error.details);
      if (detail && !opts.acknowledgeCrateChange) {
        setPendingConfirm({
          content: {
            title: 'Change this book’s crate?',
            message: res.error.message,
            crateItems: detail.items,
            confirmLabel: 'Continue placement',
          },
          destination,
          acknowledgeCrateChange: true,
        });
        return;
      }
      setServerError(res.error.message);
      toast.error(res.error.message);
      return;
    }

    const unit = isBook ? (qtyNum === 1 ? 'copy' : 'copies') : qtyNum === 1 ? 'unit' : 'units';
    const where = opts.describe ? ` ${destinationPhrase(opts.describe)}` : '';
    toast.success(`Placed ${qtyNum} ${unit} of ${itemName}${where}.`);
    // The stock genuinely moved either way; these say the LABEL did not follow.
    if (res.data.crateSyncFailed) {
      toast.warning(
        `${itemName} was placed, but its crate label could not be updated — check the book’s details.`,
      );
    } else if (res.data.crateSyncSkipped) {
      toast.warning(
        `${itemName} now has stock in more than one location, so its crate label was left unchanged.`,
      );
    }
    setPendingConfirm(null);
    setOpen(false);
    // Staging must re-render: a PARTIAL placement leaves the remainder in the
    // source bucket, and that row has to come back with its new quantity.
    router.refresh();
  }

  function submit() {
    if (!qtyValid) {
      toast.error(`Quantity must be between 1 and ${availableQuantity}.`);
      return;
    }

    const dest = chosenDestination();
    if (!dest) {
      toast.error('Select a destination location.');
      return;
    }
    if (isNew && !newFieldsFilled) {
      toast.error(newKind === 'crate' ? 'Enter a crate number.' : 'Enter a rack number.');
      return;
    }

    const destination = toActionDestination(dest);

    // 1. Does this OVERWRITE a crate someone recorded? Predicted with the same
    //    comparator the server gate uses, against the book's summary and the
    //    destination's own crate columns (never re-typed metadata).
    const next = destinationCrate(dest);
    const crateLines =
      isBook && bookStorage
        ? describeBookCrateChange({
            currentColor: bookStorage.crateColor,
            currentNumber: bookStorage.crateNumber,
            nextColor: next.color,
            nextNumber: next.number,
          })
        : [];

    // 2. Does it MINT a location? describeNewRackPlacement checks the label
    //    against this warehouse's existing rack/crate names — an existing
    //    label is reused by the server, so it is not a creation and needs no
    //    confirmation (zero friction on the common path).
    const creation =
      dest.mode === 'existing'
        ? null
        : describeNewRackPlacement({
            label: destinationLabel(dest),
            warehouseName,
            quantity: qtyNum,
            existingLabels: destinations.map((d) => d.name),
            noun: isCrateChoice(dest) ? 'crate' : 'rack',
          });
    const creating = creation !== null && !creation.exists;

    if (!creating && crateLines.length === 0) {
      void place(destination, { describe: dest });
      return;
    }

    // ONE dialog for both questions. Notices carry the things that are true
    // but not questions: the remainder left behind by a partial placement, and
    // the rack label this also changes.
    const notices: string[] = [];
    if (qtyNum < availableQuantity) {
      notices.push(
        `${availableQuantity - qtyNum} of ${availableQuantity} will stay in ${sourceLabel.toLowerCase()}, so this title will sit in more than one place.`,
      );
    }
    if (isBook && bookStorage?.rackLabel && !isCrateChoice(dest)) {
      const nextRack = destinationLabel(dest);
      if (bookStorage.rackLabel.toLowerCase() !== nextRack.toLowerCase()) {
        notices.push(`Rack will change from ${bookStorage.rackLabel} to ${nextRack}.`);
      }
    }

    setPendingConfirm({
      content: {
        title: creating ? creation!.title : 'Change this book’s crate?',
        message: creating
          ? creation!.message
          : `${itemName} is recorded in ${bookStorage?.crateLabel ?? 'a different crate'}.`,
        ...(creating && creation!.suggestions.length > 0
          ? { suggestions: creation!.suggestions }
          : {}),
        ...(crateLines.length > 0 ? { crateLines } : {}),
        ...(notices.length > 0 ? { notices } : {}),
        confirmLabel: creating ? 'Create and place' : 'Continue placement',
      },
      destination,
      acknowledgeCrateChange: crateLines.length > 0,
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
    setPendingConfirm(null);
    void place(
      { existingLocationId: match.id },
      { describe: { mode: 'existing', option: match } },
    );
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
          {/* Where this book is recorded today — context for the decision. */}
          {isBook && bookStorage && <CurrentStorageSummary storage={bookStorage} />}

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
            {/* An EXISTING crate already carries its metadata — show it rather
                than making the user re-type what the location row holds. */}
            {isBook && selectedDestination && (
              <DestinationCrateNote
                crateColor={selectedDestination.crateColor}
                crateNumber={selectedDestination.crateNumber}
              />
            )}
          </div>

          {/* Inline new rack/crate inputs */}
          {isNew && (
            <div className="space-y-3 rounded-md border p-3">
              {isBook && <DestinationKindToggle value={newKind} onChange={setNewKind} />}

              {(!isBook || newKind === 'rack') && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="place-rack-number">
                      Rack number <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="place-rack-number"
                      placeholder="e.g. A1"
                      value={rackNumber}
                      onChange={(e) => setRackNumber(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="place-rack-row">Row (optional)</Label>
                    <Input
                      id="place-rack-row"
                      placeholder="e.g. Row 3"
                      value={rackRow}
                      onChange={(e) => setRackRow(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {isBook && newKind === 'crate' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="place-crate-color">Crate color (optional)</Label>
                    <CrateColorSelect
                      id="place-crate-color"
                      value={crateColor}
                      onChange={(v) => setCrateColor(v === NO_CRATE_COLOR ? '' : v)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="place-crate-number">
                      Crate number <span className="text-destructive">*</span>
                    </Label>
                    <CrateNumberInput
                      id="place-crate-number"
                      value={crateNumber}
                      onChange={setCrateNumber}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Quantity — supports split */}
          <div className="space-y-1.5">
            <Label htmlFor="place-quantity">
              Quantity{' '}
              <span className="text-muted-foreground font-normal">
                (max {availableQuantity})
              </span>
            </Label>
            <Input
              id="place-quantity"
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
            <Label htmlFor="place-notes">Notes (optional)</Label>
            <Textarea
              id="place-notes"
              rows={2}
              value={notes}
              maxLength={2000}
              placeholder="Reason for placement…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Place stock'}
          </Button>
        </DialogFooter>
      </DialogContent>

      <PlacementConfirmDialog
        open={pendingConfirm !== null}
        content={pendingConfirm?.content ?? null}
        submitting={submitting}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (!pendingConfirm) return;
          const dest = chosenDestination();
          void place(pendingConfirm.destination, {
            acknowledgeCrateChange: pendingConfirm.acknowledgeCrateChange,
            ...(dest ? { describe: dest } : {}),
          });
        }}
        onUseSuggestion={placeIntoSuggestion}
      />
    </Dialog>
  );
}
