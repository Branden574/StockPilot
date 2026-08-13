'use client';

import {
  bookCrateAcknowledgementsMatch,
  describeBookCrateChange,
  describeBookCrateConflict,
  describeNewRackPlacement,
  describeRackChange,
  parseBookCrateChangeDetail,
  toBookCrateAcknowledgement,
  type BookCrateAcknowledgedChange,
  type BookStorageInfo,
} from '@stockpilot/core';
import { Loader2, PackageCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  CrateColorSelect,
  CrateNumberInput,
  CrateRackPositionFields,
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
  destinationPosition,
  isCrateChoice,
  newDestinationProblem,
  newDestinationReady,
  planNewDestination,
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
    /**
     * EXACTLY the crate changes this dialog put on screen — item id plus a
     * fingerprint of the crate it named. Never a blanket "yes": if the row
     * changed underneath us since it rendered, the fingerprint no longer
     * matches and the server refuses, re-asking with current truth.
     */
    acknowledged: BookCrateAcknowledgedChange[];
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

  /** The destination as chosen in this form — the input to every derivation.
   *
   *  The crate branch carries the SAME rack fields the rack branch does: a
   *  crate sits on a rack, so the toggle picks the kind of row, not which of
   *  two facts survives. Anything typed into "On rack" therefore follows the
   *  operator across the toggle instead of being silently discarded. */
  function chosenDestination(): ChosenDestination | null {
    if (isNew) {
      return newKind === 'crate'
        ? { mode: 'new-crate', crateColor, crateNumber, rackNumber, rackRow }
        : { mode: 'new-rack', rackNumber, rackRow };
    }
    return selectedDestination ? { mode: 'existing', option: selectedDestination } : null;
  }

  // THE READINESS GATE IS THE PLANNER. It used to be a hand-rolled field check
  // (`crateNumber` non-empty on the crate branch) and it drifted from
  // planNewLocation inside the very commit that added the crate's rack pair:
  // crate 13 plus a "Row" with no "On rack" number satisfied it, the planner
  // refused the pair, and this dialog offered "Create new crate ?". Delegating
  // is what the phone has always done (newLocationReady in
  // apps/mobile/src/lib/move-stock-form.ts).
  const chosen = chosenDestination();
  const newReady = chosen !== null && newDestinationReady(chosen);
  // The planner's OWN sentence, rendered inline beside the fields it is about.
  const newProblem = chosen !== null ? newDestinationProblem(chosen) : null;
  const canSubmit = !submitting && qtyValid && (isNew ? newReady : destId.length > 0);

  function toActionDestination(dest: ChosenDestination): ActionDestination {
    if (dest.mode === 'existing') return { existingLocationId: dest.option.id };
    if (dest.mode === 'new-crate') {
      // The rack pair travels WITH the crate when one was typed — it is the
      // crate's position, and the server names the row "Blue #13 on rack 38-B"
      // from exactly these fields. Omitted entirely when blank, so a crate on
      // no rack (production holds one) stays position-less and keeps matching
      // the existing "Blue #13" row.
      return {
        newRack: {
          warehouseId,
          crateNumber: dest.crateNumber.trim(),
          ...(dest.crateColor.trim() ? { crateColor: dest.crateColor.trim() } : {}),
          ...(dest.rackNumber.trim() ? { rackNumber: dest.rackNumber.trim() } : {}),
          ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
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
    opts: { acknowledged?: BookCrateAcknowledgedChange[]; describe?: ChosenDestination } = {},
  ) {
    setSubmitting(true);
    setServerError(null);
    const res = await placeStockAction({
      itemId,
      fromLocationId: sourceLocationId,
      quantity: qtyNum,
      notes: notes.trim() || undefined,
      destination,
      ...(opts.acknowledged && opts.acknowledged.length > 0
        ? { acknowledgedCrateChanges: opts.acknowledged }
        : {}),
    });
    setSubmitting(false);

    if (!res.ok) {
      // The server refused because this placement overwrites a crate a human
      // recorded. Our local prediction can be stale (the row may have changed
      // since the page rendered, and a non-Staging surface may not predict at
      // all), so the refusal is rendered from ITS payload and retried with an
      // acknowledgement built from THAT payload — the server's own reading of
      // the row, not our snapshot. Asked at most once more: a refusal that
      // survives an acknowledgement matching the server's own labels is a real
      // error, not a staleness loop.
      const detail = parseBookCrateChangeDetail(res.error.details);
      const fresh = detail ? toBookCrateAcknowledgement(detail.items) : null;
      if (detail && fresh && !bookCrateAcknowledgementsMatch(opts.acknowledged, fresh)) {
        setPendingConfirm({
          content: {
            title: 'Change this book’s crate?',
            message: res.error.message,
            crateItems: detail.items,
            confirmLabel: 'Continue placement',
          },
          destination,
          acknowledged: fresh,
        });
        return;
      }
      // Not a question we can ask again — close the confirmation and surface
      // the error on the form behind it. Leaving an already-answered
      // confirmation open would offer a Continue button that can only fail
      // again, with the inline error hidden underneath it.
      setPendingConfirm(null);
      setServerError(res.error.message);
      toast.error(res.error.message);
      return;
    }

    const unit = isBook ? (qtyNum === 1 ? 'copy' : 'copies') : qtyNum === 1 ? 'unit' : 'units';
    const where = opts.describe ? ` ${destinationPhrase(opts.describe)}` : '';
    toast.success(`Placed ${qtyNum} ${unit} of ${itemName}${where}.`);
    // The stock genuinely moved either way; these say the LABEL did not follow.
    // All three are reported the same way the Transfer dialog and the mobile
    // Move-stock modal report them — a plain success next to a summary naming a
    // crate the stock has left is the exact falsehood this whole gate exists to
    // prevent, so `crateSyncStale` warns here too rather than passing silently.
    if (res.data.crateSyncFailed) {
      toast.warning(
        `${itemName} was placed, but its crate label could not be updated — check the book’s details.`,
      );
    } else if (res.data.crateSyncStale) {
      toast.warning(
        `${itemName} was placed, but someone else changed its crate while it was moving — its label was left as they set it.`,
      );
    } else if (res.data.crateSyncUnplaced) {
      toast.warning(
        `${itemName} was placed, but none of its stock is in a rack or crate now — its crate label was left unchanged and may be wrong.`,
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
    // THE LAST GATE BEFORE ANY CONFIRMATION IS BUILT. `destinationLabel` is ''
    // for an invalid plan, and describeNewRackPlacement would happily dress
    // that up as "Create new crate ? does not exist in Main Warehouse yet."
    // Refusing here means no creation prompt can ever name nothing — and the
    // words are the planner's, so the toast, the inline message and the
    // server's zod issue are one sentence.
    const plan = planNewDestination(dest);
    if (plan?.kind === 'invalid') {
      toast.error(plan.message);
      return;
    }

    const destination = toActionDestination(dest);

    // 1. Does this OVERWRITE a crate someone recorded? Predicted with the same
    //    comparator the server gate uses, against the book's summary and the
    //    destination's own crate columns (never re-typed metadata).
    //
    //    `bookStorage` is an RSC snapshot taken when the page rendered, so this
    //    prediction can be WRONG — someone may have re-crated the book from the
    //    item screen since. That is fine now and used to be a data-loss bug:
    //    the acknowledgement below names the crate this dialog actually showed,
    //    so a snapshot that no longer matches the row is refused by the server
    //    and re-asked against current truth instead of waving the write through.
    const next = destinationCrate(dest);
    // The rack halves are LABEL context on both sides — the comparison stays
    // crate-only (see BookCratePlacementInput), but "Blue 4" and "Blue 13" mean
    // little without the rack each sits on when one crate number names five
    // different bins.
    const currentPosition = { rackNumber: bookStorage?.rackNumber, rackRow: bookStorage?.rackRow };
    const nextPosition = destinationPosition(dest);
    const crateChange =
      isBook && bookStorage
        ? describeBookCrateConflict({
            itemId,
            itemName,
            currentColor: bookStorage.crateColor,
            currentNumber: bookStorage.crateNumber,
            currentPosition,
            nextColor: next.color,
            nextNumber: next.number,
            nextPosition,
          })
        : null;
    const crateLines =
      isBook && bookStorage && crateChange
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
    // THE RACK LINE IS ITS OWN COMPARISON — and it now covers a CRATE that
    // sits on a rack, which the old `!isCrateChoice(dest)` guard skipped
    // entirely. `describeRackChange` never promises a clear, because a
    // destination with no position leaves the rack keys alone.
    if (isBook && bookStorage) {
      const rackLine = describeRackChange(
        { rackNumber: bookStorage.rackNumber, rackRow: bookStorage.rackRow },
        destinationPosition(dest),
      );
      if (rackLine) notices.push(rackLine);
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
      // ONLY the change this dialog just described, fingerprinted. An empty
      // array when the confirmation is purely about minting a rack: that
      // question has nothing to do with the book's crate, and answering it must
      // not also answer one the user was never asked.
      acknowledged: crateChange ? toBookCrateAcknowledgement([crateChange]) : [],
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
                <>
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
                  {/* A crate SITS ON a rack — both, or the picker only ever
                      learns half of where the book is. */}
                  <CrateRackPositionFields
                    idPrefix="place"
                    rackNumber={rackNumber}
                    rackRow={rackRow}
                    onRackNumberChange={setRackNumber}
                    onRackRowChange={setRackRow}
                  />
                </>
              )}

              {/* The planner's refusal, said where the fields are. Without it a
                  half-filled form would just have a dead Place button and no
                  explanation — and the version of this dialog that had neither
                  offered to create a crate it could not name. */}
              {newProblem && <p className="text-destructive text-xs">{newProblem}</p>}
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
            acknowledged: pendingConfirm.acknowledged,
            ...(dest ? { describe: dest } : {}),
          });
        }}
        onUseSuggestion={placeIntoSuggestion}
      />
    </Dialog>
  );
}
