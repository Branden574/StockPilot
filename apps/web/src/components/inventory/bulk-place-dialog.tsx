'use client';

import {
  bookCrateAcknowledgementsMatch,
  describeBookCrateConflict,
  describeNewRackPlacement,
  parseBookCrateChangeDetail,
  toBookCrateAcknowledgement,
  type BookCrateAcknowledgedChange,
  type BookCrateChangeItem,
  type BookStorageInfo,
} from '@stockpilot/core';
import { Loader2, PackageCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  CrateColorSelect,
  CrateNumberInput,
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
import { bulkPlaceStockAction } from '@/server/actions/inventory';

const NEW_RACK_SENTINEL = '__new__';

type ActionDestination = Parameters<typeof bulkPlaceStockAction>[0]['destination'];

export interface BulkPlaceRow {
  itemId: string;
  name: string;
  /** 'book' unlocks the crate destination — see the mixed-selection rule below. */
  itemType: string;
  sourceLocationId: string;
  quantity: number;
  warehouseId: string | null;
  /** The book's recorded crate summary, for the aggregated change warning. */
  bookStorage?: BookStorageInfo | null;
}

interface BulkPlaceDialogProps {
  rows: BulkPlaceRow[];
  /** warehouseId → rack/crate destinations (same map the per-item dialog uses). */
  destinationsMap: Record<string, DestinationOption[]>;
  /** warehouseId → display name, for the new-rack confirmation copy. */
  warehouseNames: Record<string, string>;
  /** Called after a successful (full or partial) place so the parent can clear selection. */
  onPlaced: () => void;
  trigger: React.ReactNode;
}

export function BulkPlaceDialog({ rows, destinationsMap, warehouseNames, onPlaced, trigger }: BulkPlaceDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const [destId, setDestId] = React.useState<string>('');
  const [notes, setNotes] = React.useState('');
  const [newKind, setNewKind] = React.useState<NewDestinationKind>('rack');
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // ONE confirmation for the whole batch, however many questions it raises: a
  // genuinely-new rack/crate (the 2026-07-23 guard — bulk had none, so a typed
  // name minted a rack and dumped EVERY selected row into it) and/or the crate
  // overwrite the server gates on. Never N dialogs: the crate warning is
  // aggregated by the crate each title is recorded in today.
  const [pendingConfirm, setPendingConfirm] = React.useState<{
    content: PlacementConfirmContent;
    destination: ActionDestination;
    /**
     * EXACTLY the crate changes this dialog listed — per book, with the crate
     * it named fingerprinted. A book whose row changed since the selection
     * rendered fingerprints differently, so the server refuses the batch and
     * re-asks rather than taking one click as consent for 200 unseen changes.
     */
    acknowledged: BookCrateAcknowledgedChange[];
    describe: ChosenDestination | null;
  } | null>(null);

  // All selected rows must share ONE warehouse — a rack belongs to a single
  // warehouse, so a shared destination is only meaningful within one. Rows with
  // no warehouse can't be placed.
  const warehouseIds = React.useMemo(
    () => [...new Set(rows.map((r) => r.warehouseId))],
    [rows],
  );
  const singleWarehouse = warehouseIds.length === 1 && warehouseIds[0] != null;
  const warehouseId = singleWarehouse ? (warehouseIds[0] as string) : null;
  const destinations = warehouseId ? (destinationsMap[warehouseId] ?? []) : [];
  const warehouseName = warehouseId ? (warehouseNames[warehouseId] ?? null) : null;

  const totalUnits = rows.reduce((s, r) => s + r.quantity, 0);
  const isNew = destId === NEW_RACK_SENTINEL;
  const selectedDestination = destinations.find((d) => d.id === destId) ?? null;

  // MIXED SELECTIONS ARE RACK-ONLY (for inline creation).
  //
  // `book_crate_*` is a BOOK key — a non-book placed in a crate gets no crate
  // summary at all, so offering the crate form for a mixed selection would ask
  // for metadata that silently applies to some rows and not others. The two
  // honest options were "rack only" and "two clearly separated sections", and
  // rack-only wins because the crate branch is not a display variant, it is a
  // different `locations.kind`. An EXISTING crate stays selectable for a mixed
  // batch (that has always been possible, and the stock really can go there) —
  // the note below just says plainly which rows get a label out of it.
  const bookCount = rows.filter((r) => r.itemType === 'book').length;
  const allBooks = rows.length > 0 && bookCount === rows.length;
  const nonBookCount = rows.length - bookCount;

  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset fields on open */
    setDestId('');
    setNotes('');
    setNewKind('rack');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setPendingConfirm(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale confirmation on edit
    setPendingConfirm(null);
  }, [destId, newKind, rackNumber, rackRow, crateColor, crateNumber]);

  const newFieldsFilled =
    newKind === 'rack' ? rackNumber.trim().length > 0 : crateNumber.trim().length > 0;
  const canSubmit =
    !submitting &&
    singleWarehouse &&
    rows.length > 0 &&
    (isNew ? newFieldsFilled : destId.length > 0);

  function chosenDestination(): ChosenDestination | null {
    if (isNew) {
      return allBooks && newKind === 'crate'
        ? { mode: 'new-crate', crateColor, crateNumber }
        : { mode: 'new-rack', rackNumber, rackRow };
    }
    return selectedDestination ? { mode: 'existing', option: selectedDestination } : null;
  }

  function toActionDestination(dest: ChosenDestination): ActionDestination {
    if (dest.mode === 'existing') return { existingLocationId: dest.option.id };
    if (dest.mode === 'new-crate') {
      return {
        newRack: {
          warehouseId: warehouseId!,
          crateNumber: dest.crateNumber.trim(),
          ...(dest.crateColor.trim() ? { crateColor: dest.crateColor.trim() } : {}),
        },
      };
    }
    return {
      newRack: {
        warehouseId: warehouseId!,
        rackNumber: dest.rackNumber.trim(),
        ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
      },
    };
  }

  /**
   * Which selected BOOKS would have a recorded crate overwritten, using the
   * same comparator the server gate runs. Non-books are absent by
   * construction: they carry no crate summary to destroy.
   */
  function predictCrateChanges(dest: ChosenDestination): BookCrateChangeItem[] {
    const next = destinationCrate(dest);
    const changed: BookCrateChangeItem[] = [];
    for (const r of rows) {
      if (r.itemType !== 'book' || !r.bookStorage) continue;
      // ONE constructor with the server gate, so the fingerprint each line
      // carries is computed exactly the way the server will recompute it.
      // `bookStorage` is a render-time snapshot: when it has gone stale the
      // fingerprints simply disagree and the server re-asks — which is the
      // point. A prediction is a courtesy, never an authority.
      const conflict = describeBookCrateConflict({
        itemId: r.itemId,
        itemName: r.name,
        currentColor: r.bookStorage.crateColor,
        currentNumber: r.bookStorage.crateNumber,
        nextColor: next.color,
        nextNumber: next.number,
      });
      if (conflict) changed.push(conflict);
    }
    return changed;
  }

  function submit() {
    if (!warehouseId) {
      toast.error('Select items from a single warehouse to place them together.');
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
    const crateItems = predictCrateChanges(dest);

    const creation =
      dest.mode === 'existing'
        ? null
        : describeNewRackPlacement({
            label: destinationLabel(dest),
            warehouseName,
            quantity: totalUnits,
            existingLabels: destinations.map((d) => d.name),
            noun: isCrateChoice(dest) ? 'crate' : 'rack',
          });
    const creating = creation !== null && !creation.exists;

    if (!creating && crateItems.length === 0) {
      void place(destination, { describe: dest });
      return;
    }

    const notices: string[] = [];
    if (nonBookCount > 0 && isCrateChoice(dest)) {
      notices.push(
        `${nonBookCount} of the ${rows.length} selected rows ${nonBookCount === 1 ? 'is not a book' : 'are not books'}, so no crate is recorded for ${nonBookCount === 1 ? 'it' : 'them'}.`,
      );
    }

    setPendingConfirm({
      content: {
        title: creating ? creation!.title : 'Change the recorded crate?',
        message: creating
          ? creation!.message
          : `Placing this selection into ${destinationLabel(dest)} changes the crate recorded on ${crateItems.length} ${crateItems.length === 1 ? 'title' : 'titles'}.`,
        ...(creating && creation!.suggestions.length > 0
          ? { suggestions: creation!.suggestions }
          : {}),
        ...(crateItems.length > 0 ? { crateItems } : {}),
        ...(notices.length > 0 ? { notices } : {}),
        confirmLabel: creating ? `Create and place ${rows.length}` : 'Continue placement',
      },
      destination,
      // Only the books this dialog actually listed, each pinned to the crate it
      // was listed as being in.
      acknowledged: toBookCrateAcknowledgement(crateItems),
      describe: dest,
    });
  }

  // "Did you mean 10-A?" — place into the EXISTING rack the worker probably
  // meant. The suggestion is an existing label; map it to that destination id.
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

  async function place(
    destination: ActionDestination,
    opts: {
      acknowledged?: BookCrateAcknowledgedChange[];
      describe?: ChosenDestination | null;
    } = {},
  ) {
    setSubmitting(true);
    const res = await bulkPlaceStockAction({
      placements: rows.map((r) => ({
        itemId: r.itemId,
        fromLocationId: r.sourceLocationId,
        quantity: r.quantity,
      })),
      notes: notes.trim() || undefined,
      destination,
      ...(opts.acknowledged && opts.acknowledged.length > 0
        ? { acknowledgedCrateChanges: opts.acknowledged }
        : {}),
    });
    setSubmitting(false);

    if (!res.ok) {
      // The batch gate is all-or-nothing and fires BEFORE anything moves, so a
      // refusal here means nothing was placed. Re-render it from the server's
      // own payload — it names every affected book, including any our local
      // prediction missed OR got wrong — and retry with an acknowledgement
      // built from THAT payload. Re-asked only while the payload says something
      // our last acknowledgement did not cover; an identical refusal is a real
      // error, not a staleness loop.
      const detail = parseBookCrateChangeDetail(res.error.details);
      const fresh = detail ? toBookCrateAcknowledgement(detail.items) : null;
      if (detail && fresh && !bookCrateAcknowledgementsMatch(opts.acknowledged, fresh)) {
        setPendingConfirm({
          content: {
            title: 'Change the recorded crate?',
            message: res.error.message,
            crateItems: detail.items,
            confirmLabel: 'Continue placement',
          },
          destination,
          acknowledged: fresh,
          describe: opts.describe ?? null,
        });
        return;
      }
      // Not a question we can ask again — close the confirmation rather than
      // leave a Continue button that can only fail the same way.
      setPendingConfirm(null);
      toast.error(res.error.message);
      return;
    }

    const { placed, failed } = res.data;
    const where = opts.describe ? ` ${destinationPhrase(opts.describe)}` : '';
    if (failed.length === 0) {
      toast.success(`Placed ${placed} ${placed === 1 ? 'item' : 'items'}${where}.`);
    } else if (placed > 0) {
      toast.warning(`Placed ${placed}, but ${failed.length} could not be placed.`);
    } else {
      toast.error('Nothing could be placed.');
    }
    // The stock genuinely moved either way; these say the crate LABEL did not
    // follow it. Reported the same way, and in the same order, as the Transfer
    // dialog and the mobile Move-stock modal report them — a bare "Placed 10
    // items" next to a summary still naming a crate those items have left is
    // the exact falsehood the gate exists to prevent, so `crateSyncStale` warns
    // here too rather than passing silently.
    if (res.data.crateSyncFailed) {
      toast.warning('Some crate labels could not be updated — check those books’ details.');
    } else if (res.data.crateSyncStale) {
      toast.warning(
        'Someone else changed some titles’ crates while they were moving — those labels were left as they set them.',
      );
    } else if (res.data.crateSyncUnplaced) {
      toast.warning(
        'Some titles have no stock in a rack or crate now, so their crate labels were left unchanged and may be wrong.',
      );
    } else if (res.data.crateSyncSkipped) {
      toast.warning(
        'Some titles now hold stock in more than one location, so their crate labels were left unchanged.',
      );
    }
    setPendingConfirm(null);
    setOpen(false);
    onPlaced();
    // A partial placement leaves the remainder in staging; it has to come back.
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Place {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </DialogTitle>
          <DialogDescription>
            Move <span className="tabular-nums">{totalUnits}</span> total units from staging /
            unplaced into one rack or crate.
          </DialogDescription>
        </DialogHeader>

        {!singleWarehouse ? (
          <p className="text-destructive text-sm">
            The selected items span multiple warehouses (or have none). Select items from a single
            warehouse to place them together.
          </p>
        ) : (
          <div className="space-y-3">
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
                  <SelectItem value={NEW_RACK_SENTINEL}>
                    {allBooks ? '+ New rack / crate' : '+ New rack'}
                  </SelectItem>
                </SelectContent>
              </Select>
              {selectedDestination && (
                <DestinationCrateNote
                  crateColor={selectedDestination.crateColor}
                  crateNumber={selectedDestination.crateNumber}
                />
              )}
              {selectedDestination?.kind === 'crate' && nonBookCount > 0 && (
                <p className="text-muted-foreground text-xs">
                  {nonBookCount} of the {rows.length} selected rows{' '}
                  {nonBookCount === 1 ? 'is not a book' : 'are not books'} — no crate is recorded
                  for {nonBookCount === 1 ? 'it' : 'them'}.
                </p>
              )}
            </div>

            {isNew && (
              <div className="space-y-3 rounded-md border p-3">
                {allBooks ? (
                  <DestinationKindToggle value={newKind} onChange={setNewKind} />
                ) : (
                  <p className="text-muted-foreground text-xs">
                    The selection includes items that are not books, so a new location here is a
                    rack. Place books on their own to create a crate.
                  </p>
                )}

                {(!allBooks || newKind === 'rack') && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="bulk-rack-number">
                        Rack number <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="bulk-rack-number"
                        placeholder="e.g. A1"
                        value={rackNumber}
                        onChange={(e) => setRackNumber(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bulk-rack-row">Row (optional)</Label>
                      <Input
                        id="bulk-rack-row"
                        placeholder="e.g. Row 3"
                        value={rackRow}
                        onChange={(e) => setRackRow(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {allBooks && newKind === 'crate' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="bulk-crate-color">Crate color (optional)</Label>
                      <CrateColorSelect
                        id="bulk-crate-color"
                        value={crateColor}
                        onChange={(v) => setCrateColor(v === NO_CRATE_COLOR ? '' : v)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bulk-crate-number">
                        Crate number <span className="text-destructive">*</span>
                      </Label>
                      <CrateNumberInput
                        id="bulk-crate-number"
                        value={crateNumber}
                        onChange={setCrateNumber}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="bulk-notes">Notes (optional)</Label>
              <Textarea
                id="bulk-notes"
                rows={2}
                value={notes}
                maxLength={2000}
                placeholder="Reason for placement…"
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <PackageCheck className="h-4 w-4" /> Place {rows.length}
              </>
            )}
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
          void place(pendingConfirm.destination, {
            acknowledged: pendingConfirm.acknowledged,
            describe: pendingConfirm.describe,
          });
        }}
        onUseSuggestion={placeIntoSuggestion}
      />
    </Dialog>
  );
}
