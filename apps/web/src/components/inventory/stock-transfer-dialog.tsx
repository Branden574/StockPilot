'use client';

import { ArrowRightLeft, Loader2 } from 'lucide-react';
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
import { transferStockAction } from '@/server/actions/inventory';
import { transferableHoldings } from '@/lib/placements';

/** Sentinel Select value for the inline "create a new location" branch —
 *  mirrors PlaceFromStagingDialog's NEW_RACK_SENTINEL. */
const NEW_LOCATION_SENTINEL = '__new__';

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

  // Inline new-rack/crate fields (same shape as PlaceFromStagingDialog).
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);
  // Server failures render inline (persistent) as well as via toast — a toast
  // alone auto-dismisses in seconds and sits outside the modal, so a rejected
  // submit can read as "nothing happened" (bit us live with plan_limit_exceeded).
  const [serverError, setServerError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset on open/close */
    setFromLocation(sourceHoldings[0]?.locationId ?? '');
    setToLocation('');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setServerError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // sourceHoldings is derived from holdings prop, which is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  async function submit() {
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

    let destination: Parameters<typeof transferStockAction>[0]['destination'];
    if (isNew) {
      if (!sourceWarehouseId) {
        toast.error('Pick a source location inside a warehouse first.');
        return;
      }
      if (!rackNumber.trim()) {
        toast.error('Enter a rack number.');
        return;
      }
      destination = {
        newRack: {
          warehouseId: sourceWarehouseId,
          rackNumber: rackNumber.trim(),
          ...(rackRow.trim() ? { rackRow: rackRow.trim() } : {}),
          ...(isBook && crateColor.trim() ? { crateColor: crateColor.trim() } : {}),
          ...(isBook && crateNumber.trim() ? { crateNumber: crateNumber.trim() } : {}),
        },
      };
    } else {
      destination = { existingLocationId: toLocation };
    }

    setSubmitting(true);
    setServerError(null);
    const res = await transferStockAction({
      itemId,
      fromLocationId: fromLocation,
      quantity: qtyNum,
      notes: notes || undefined,
      destination,
    });
    setSubmitting(false);
    if (!res.ok) {
      setServerError(res.error.message);
      toast.error(res.error.message);
      return;
    }
    toast.success(`Transferred ${qtyNum} ${qtyNum === 1 ? 'unit' : 'units'}.`);
    setOpen(false);
    setQuantity('1');
    setNotes('');
    router.refresh();
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

            {/* Inline new rack/crate inputs — same fields the Staging place
                dialog uses; the location is created in the source holding's
                warehouse, then the normal transfer runs against it. */}
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
            disabled={submitting || hasNoSources || (isNew && !rackNumber.trim())}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Transfer stock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
