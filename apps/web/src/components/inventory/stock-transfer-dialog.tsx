'use client';

import {
  bookCrateAcknowledgementsMatch,
  describeNewRackPlacement,
  parseBookCrateChangeDetail,
  toBookCrateAcknowledgement,
  type BookCrateAcknowledgedChange,
  type BookStorageInfo,
} from '@stockpilot/core';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  CrateColorSelect,
  CrateNumberInput,
  CrateRackPositionFields,
  CurrentStorageSummary,
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
import {
  destinationLabel,
  isCrateChoice,
  newDestinationProblem,
  newDestinationReady,
  planNewDestination,
  type ChosenDestination,
} from '@/lib/locations/placement-destination';
import { transferStockAction } from '@/server/actions/inventory';
import { transferableHoldings } from '@/lib/placements';

/** Sentinel Select value for the inline "create a new location" branch —
 *  mirrors PlaceFromStagingDialog's NEW_RACK_SENTINEL. */
const NEW_LOCATION_SENTINEL = '__new__';

type ActionDestination = Parameters<typeof transferStockAction>[0]['destination'];

interface LocationOption {
  id: string;
  name: string;
  kind: string | null;
  warehouse_id: string | null;
}

interface HoldingOption {
  locationId: string;
  name: string;
  kind: string | null;
  warehouseId: string | null;
  quantity: number;
}

interface StockTransferDialogProps {
  itemId: string;
  itemName: string;
  currentQuantity: number;
  currentLocationId: string | null;
  locations: LocationOption[];
  holdings: HoldingOption[];
  /** Drives the book-only crate fields on the inline new-location form. */
  itemType?: string | null;
  /**
   * A BOOK's recorded rack/crate summary, shown as CONTEXT only.
   *
   * Deliberately NOT used to predict the crate confirmation the way the Staging
   * dialog does. This is an RSC snapshot, and the only thing a snapshot can do
   * here is ask the wrong question; the server compares against the row it just
   * read and refuses with a payload naming the CURRENT crate, and that refusal
   * is the only thing this dialog ever confirms from. One extra round trip on
   * the rare crated transfer, zero chance of confirming a crate that moved.
   */
  bookStorage?: BookStorageInfo | null;
  /** Show the "New location…" destination only when the user can actually
   *  create locations (server still asserts 'locations:manage' + plan limit). */
  canManageLocations?: boolean;
  trigger?: React.ReactNode;
}

export function StockTransferDialog({
  itemId,
  itemName,
  currentQuantity,
  locations,
  holdings,
  itemType,
  bookStorage,
  canManageLocations = false,
  trigger,
}: StockTransferDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const sourceHoldings = transferableHoldings(holdings);
  const defaultFrom = sourceHoldings[0]?.locationId ?? '';

  const [fromLocation, setFromLocation] = React.useState<string>(defaultFrom);
  const [toLocation, setToLocation] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState('1');
  const [notes, setNotes] = React.useState('');

  // Inline new-rack/crate fields. `newKind` is an EXPLICIT choice of the KIND
  // of row, exactly as in the Staging put-away dialog — see the rule in
  // packages/core/src/inventory/new-location.ts. This form used to send a rack
  // number AND the optional crate pair together, which the server then resolved
  // by precedence: "A1" + "Row 3" + crate "9" created a CRATE called "Crate #9"
  // and threw the row away (REPRO B). The row is no longer thrown away: that
  // input is CRATE 9 ON RACK A1-Row 3, and the crate branch keeps the same rack
  // fields so the operator can say so.
  const [newKind, setNewKind] = React.useState<NewDestinationKind>('rack');
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);
  // Server failures render inline (persistent) as well as via toast — a toast
  // alone auto-dismisses in seconds and sits outside the modal, so a rejected
  // submit can read as "nothing happened" (bit us live with plan_limit_exceeded).
  const [serverError, setServerError] = React.useState<string | null>(null);
  // ONE confirmation, whichever question it has to ask: minting a location that
  // does not exist (the 2026-07-23 guard) or overwriting a crate a human
  // recorded (the server's gate).
  const [pendingConfirm, setPendingConfirm] = React.useState<{
    content: PlacementConfirmContent;
    destination: ActionDestination;
    /** EXACTLY the crate changes shown, fingerprinted. Empty for a pure
     *  create-this-location question — answering that must not also answer a
     *  crate question nobody asked. */
    acknowledged: BookCrateAcknowledgedChange[];
  } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset on open/close */
    setFromLocation(sourceHoldings[0]?.locationId ?? '');
    setToLocation('');
    setNewKind('rack');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setServerError(null);
    setPendingConfirm(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // sourceHoldings is derived from holdings prop, which is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A pending confirmation names a specific label and quantity, so it must not
  // outlive the inputs it described. Re-deriving it costs one click.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale confirmation on edit
    setPendingConfirm(null);
  }, [toLocation, newKind, rackNumber, rackRow, crateColor, crateNumber, quantity, fromLocation]);

  const qtyNum = Number.parseFloat(quantity) || 0;

  // Max transferable = the selected source holding's qty (not total on-hand)
  const selectedHolding = sourceHoldings.find((h) => h.locationId === fromLocation);
  const maxTransferable = selectedHolding?.quantity ?? 0;

  // A new location is created inside the SOURCE holding's warehouse — without
  // a known warehouse there's nowhere to create it, so the option hides.
  const sourceWarehouseId = selectedHolding?.warehouseId ?? null;
  const canCreateHere = canManageLocations && !!sourceWarehouseId;

  const isNew = toLocation === NEW_LOCATION_SENTINEL;
  const isBook = itemType === 'book';

  // Destination: all locations except the chosen source and system kinds
  const destinationLocations = locations.filter(
    (l) =>
      l.id !== fromLocation &&
      l.kind !== 'staging' &&
      l.kind !== 'unplaced',
  );

  const fromLoc = locations.find((l) => l.id === fromLocation);
  const toLoc = locations.find((l) => l.id === toLocation);
  const crossWarehouse =
    !isNew && !!fromLoc && !!toLoc && fromLoc.warehouse_id !== toLoc.warehouse_id;

  const hasNoSources = sourceHoldings.length === 0;

  /**
   * The destination as chosen in this form.
   *
   * `null` for an EXISTING location: this dialog's location list carries only
   * {id, name, kind}, so it cannot honestly build a DestinationOption with the
   * crate columns — and it does not need to. An existing destination mints
   * nothing (no creation confirmation) and its crate metadata is read
   * server-side from the row itself, which is the only trustworthy copy.
   */
  function chosenNewDestination(): ChosenDestination | null {
    if (!isNew) return null;
    return isBook && newKind === 'crate'
      ? { mode: 'new-crate', crateColor, crateNumber, rackNumber, rackRow }
      : { mode: 'new-rack', rackNumber, rackRow };
  }

  // THE READINESS GATE IS THE PLANNER — see newDestinationReady. The
  // hand-rolled version here checked `crateNumber` alone on the crate branch,
  // so crate 13 plus a "Row" with no "On rack" number passed it while
  // planNewLocation refused the pair, and this dialog rendered "Create new crate
  // ? does not exist yet." A crate is still identified by its NUMBER and a rack
  // by its number; neither branch demands the other's field. That rule now lives
  // in exactly one place.
  const chosenNew = chosenNewDestination();
  const newReady = chosenNew !== null && newDestinationReady(chosenNew);
  const newProblem = chosenNew !== null ? newDestinationProblem(chosenNew) : null;

  function toActionDestination(dest: ChosenDestination): ActionDestination {
    if (dest.mode === 'existing') return { existingLocationId: dest.option.id };
    if (dest.mode === 'new-crate') {
      // The rack pair is the crate's POSITION and travels with it when typed —
      // the server names the row "Blue #13 on rack 38-B" from these very
      // fields. Blank means a crate on no rack, which stays a legitimate shape.
      return {
        newRack: {
          warehouseId: sourceWarehouseId!,
          crateNumber: dest.crateNumber.trim(),
          ...(dest.crateColor.trim() ? { crateColor: dest.crateColor.trim() } : {}),
          ...(dest.rackNumber.trim() ? { rackNumber: dest.rackNumber.trim() } : {}),
          ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
        },
      };
    }
    return {
      newRack: {
        warehouseId: sourceWarehouseId!,
        rackNumber: dest.rackNumber.trim(),
        ...(dest.rackRow.trim() ? { rackRow: dest.rackRow.trim() } : {}),
      },
    };
  }

  async function move(
    destination: ActionDestination,
    opts: { acknowledged?: BookCrateAcknowledgedChange[] } = {},
  ) {
    setSubmitting(true);
    setServerError(null);
    const res = await transferStockAction({
      itemId,
      fromLocationId: fromLocation,
      quantity: qtyNum,
      notes: notes || undefined,
      destination,
      ...(opts.acknowledged && opts.acknowledged.length > 0
        ? { acknowledgedCrateChanges: opts.acknowledged }
        : {}),
    });
    setSubmitting(false);

    if (!res.ok) {
      // The server refused because this move overwrites a crate a human
      // recorded. Render THAT payload — it is the server's own reading of the
      // row, taken moments ago — and retry with an acknowledgement built from
      // it. Asked at most once more: a refusal that survives an acknowledgement
      // matching the server's own labels is a real error, not a staleness loop.
      const detail = parseBookCrateChangeDetail(res.error.details);
      const fresh = detail ? toBookCrateAcknowledgement(detail.items) : null;
      if (detail && fresh && !bookCrateAcknowledgementsMatch(opts.acknowledged, fresh)) {
        setPendingConfirm({
          content: {
            title: 'Change this book’s crate?',
            message: res.error.message,
            crateItems: detail.items,
            confirmLabel: 'Continue transfer',
          },
          destination,
          acknowledged: fresh,
        });
        return;
      }
      // Not a question we can ask again — close the confirmation and surface the
      // error on the form behind it, rather than leaving a Continue button that
      // can only fail again with the inline error hidden underneath.
      setPendingConfirm(null);
      setServerError(res.error.message);
      toast.error(res.error.message);
      return;
    }

    toast.success(`Transferred ${qtyNum} ${qtyNum === 1 ? 'unit' : 'units'}.`);
    // The stock genuinely moved either way; these say the crate LABEL did not
    // follow it. Silence here would make a move that relabelled nothing
    // indistinguishable from one that did.
    if (res.data?.crateSyncFailed) {
      toast.warning(
        `${itemName} was moved, but its crate label could not be updated — check the book’s details.`,
      );
    } else if (res.data?.crateSyncStale) {
      toast.warning(
        `${itemName} was moved, but someone else changed its crate while it was moving — its label was left as they set it.`,
      );
    } else if (res.data?.crateSyncUnplaced) {
      toast.warning(
        `${itemName} was moved, but none of its stock is in a rack or crate now — its crate label was left unchanged and may be wrong.`,
      );
    } else if (res.data?.crateSyncSkipped) {
      toast.warning(
        `${itemName} now has stock in more than one location, so its crate label was left unchanged.`,
      );
    }
    setPendingConfirm(null);
    setOpen(false);
    setQuantity('1');
    setNotes('');
    router.refresh();
  }

  function submit() {
    if (!fromLocation || !toLocation) {
      toast.error('Pick both a source and a destination location.');
      return;
    }
    if (!isNew && fromLocation === toLocation) {
      toast.error('Source and destination must be different locations.');
      return;
    }
    if (qtyNum <= 0) {
      toast.error('Enter a positive quantity to transfer.');
      return;
    }
    if (qtyNum > maxTransferable) {
      toast.error("Can't transfer more than what's in the source location.");
      return;
    }
    if (isNew && !sourceWarehouseId) {
      toast.error('Pick a source location inside a warehouse first.');
      return;
    }

    const dest = chosenNewDestination();
    // THE LAST GATE BEFORE ANY CONFIRMATION IS BUILT: `destinationLabel` is ''
    // for an invalid plan, and describeNewRackPlacement would dress that up as
    // "Create new crate ?". The words are the planner's, so this toast, the
    // inline message and the server's zod issue are one sentence.
    const plan = dest ? planNewDestination(dest) : null;
    if (plan?.kind === 'invalid') {
      toast.error(plan.message);
      return;
    }

    const destination: ActionDestination = dest
      ? toActionDestination(dest)
      : { existingLocationId: toLocation };

    // Does this MINT a location? The label comes from the SAME derivation the
    // server names the row with, so the sentence always names what will
    // actually be created — the phone once asked "Create new rack A1?" and
    // created "Crate #9" (REPRO A'). Existence is judged inside the source
    // holding's warehouse, because that is the warehouse the server creates in.
    const creation = dest
      ? describeNewRackPlacement({
          label: destinationLabel(dest),
          quantity: qtyNum,
          existingLabels: locations
            .filter((l) => l.warehouse_id === sourceWarehouseId)
            .map((l) => l.name),
          noun: isCrateChoice(dest) ? 'crate' : 'rack',
        })
      : null;

    if (creation === null || creation.exists) {
      void move(destination);
      return;
    }

    setPendingConfirm({
      content: {
        title: creation.title,
        message: creation.message,
        ...(creation.suggestions.length > 0 ? { suggestions: creation.suggestions } : {}),
        confirmLabel: 'Create and transfer',
      },
      destination,
      // Nothing about the book's crate was asked here, so nothing about it is
      // answered. If the move then overwrites a recorded crate, the server
      // refuses and THAT question gets asked on its own.
      acknowledged: [],
    });
  }

  /** "Did you mean 10-A?" — move into the EXISTING location instead of minting
   *  the typo. Resolved within the source warehouse so a same-named rack
   *  elsewhere is never the target. */
  function moveIntoSuggestion(label: string) {
    const match = locations.find(
      (l) =>
        l.warehouse_id === sourceWarehouseId &&
        l.name.trim().toLowerCase() === label.trim().toLowerCase(),
    );
    if (!match) return;
    setPendingConfirm(null);
    void move({ existingLocationId: match.id });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline">
            <ArrowRightLeft className="h-4 w-4" />
            Transfer
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer stock</DialogTitle>
          <DialogDescription>
            Move <span className="font-medium text-foreground">{itemName}</span> between
            locations. Current on hand:{' '}
            <span className="tabular-nums">{currentQuantity}</span>.
          </DialogDescription>
        </DialogHeader>

        {hasNoSources ? (
          <p className="text-muted-foreground text-sm">
            This item&apos;s stock is in Staging/Unplaced — placement is handled in the
            staging workflow.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Where this book is recorded today — context for the decision. */}
            {isBook && bookStorage && <CurrentStorageSummary storage={bookStorage} />}

            <div className="space-y-1.5">
              <Label>From location</Label>
              <Select
                value={fromLocation}
                onValueChange={(v) => {
                  setFromLocation(v);
                  // The inline-create branch is pinned to the SOURCE's
                  // warehouse; a new source may not have one, so drop the
                  // sentinel selection rather than creating somewhere stale.
                  if (toLocation === NEW_LOCATION_SENTINEL) setToLocation('');
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  {sourceHoldings.map((h) => (
                    <SelectItem key={h.locationId} value={h.locationId}>
                      {h.name} · {h.quantity} avail
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>To location</Label>
              <Select value={toLocation} onValueChange={setToLocation}>
                <SelectTrigger>
                  <SelectValue placeholder="Select destination" />
                </SelectTrigger>
                <SelectContent>
                  {destinationLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                  {canCreateHere && (
                    <SelectItem value={NEW_LOCATION_SENTINEL}>+ New location…</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {crossWarehouse && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  This transfer crosses warehouses. Both warehouses must be in your access
                  scope.
                </p>
              )}
            </div>

            {/* Inline new rack/crate inputs — same fields, same rule and the
                same explicit Rack|Crate choice as the Staging place dialog. */}
            {isNew && (
              <div className="space-y-3 rounded-md border p-3">
                {isBook && <DestinationKindToggle value={newKind} onChange={setNewKind} />}

                {(!isBook || newKind === 'rack') && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-rack-number">
                        Rack number <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="transfer-rack-number"
                        placeholder="e.g. A1"
                        value={rackNumber}
                        onChange={(e) => setRackNumber(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="transfer-rack-row">Row (optional)</Label>
                      <Input
                        id="transfer-rack-row"
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
                        <Label htmlFor="transfer-crate-color">Crate color (optional)</Label>
                        {/* The CRATE_COLORS registry, not a free-text box. Typing
                            "navy" here minted a color no swatch, filter or label
                            sheet can render — and every mixed-case spelling that
                            reached locations.crate_color came in this way. */}
                        <CrateColorSelect
                          id="transfer-crate-color"
                          value={crateColor}
                          onChange={(v) => setCrateColor(v === NO_CRATE_COLOR ? '' : v)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="transfer-crate-number">
                          Crate number <span className="text-destructive">*</span>
                        </Label>
                        <CrateNumberInput
                          id="transfer-crate-number"
                          value={crateNumber}
                          onChange={setCrateNumber}
                        />
                      </div>
                    </div>
                    <CrateRackPositionFields
                      idPrefix="transfer"
                      rackNumber={rackNumber}
                      rackRow={rackRow}
                      onRackNumberChange={setRackNumber}
                      onRackRowChange={setRackRow}
                    />
                  </>
                )}

                {/* The planner's refusal, said where the fields are — so a
                    disabled Transfer button always has a stated reason. */}
                {newProblem && <p className="text-destructive text-xs">{newProblem}</p>}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <Input
                type="number"
                step="1"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea
                rows={2}
                value={notes}
                maxLength={2000}
                placeholder="Why is this stock moving?"
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || hasNoSources || (isNew && !newReady)}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Transfer stock'}
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
          void move(pendingConfirm.destination, { acknowledged: pendingConfirm.acknowledged });
        }}
        onUseSuggestion={moveIntoSuggestion}
      />
    </Dialog>
  );
}
