'use client';

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
import { describeNewRackPlacement } from '@stockpilot/core';

import { bulkPlaceStockAction } from '@/server/actions/inventory';

const NEW_RACK_SENTINEL = '__new__';

interface DestinationOption {
  id: string;
  name: string;
  kind: string;
}

export interface BulkPlaceRow {
  itemId: string;
  name: string;
  sourceLocationId: string;
  quantity: number;
  warehouseId: string | null;
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
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // The 2026-07-23 new-rack confirmation, same as PlaceFromStagingDialog. Bulk
  // place had NO guard, so a typed rack name minted a rack and dumped EVERY
  // selected row's stock into it silently — the same incident, worse. Set only
  // when a genuinely-new rack is about to be created; holds the copy + the
  // one-tap near-match alternatives.
  const [pendingNewRack, setPendingNewRack] = React.useState<{
    title: string;
    message: string;
    suggestions: string[];
    destination: Parameters<typeof bulkPlaceStockAction>[0]['destination'];
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

  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset fields on open */
    setDestId('');
    setNotes('');
    setRackNumber('');
    setRackRow('');
    setPendingNewRack(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  const canSubmit =
    !submitting &&
    singleWarehouse &&
    rows.length > 0 &&
    (isNew ? rackNumber.trim().length > 0 : destId.length > 0);

  function submit() {
    if (!warehouseId) {
      toast.error('Select items from a single warehouse to place them together.');
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

    // A typed rack destination: confirm before minting it (same guard as the
    // single-item dialog). findOrCreateRackOrCrate reuses a name match, so an
    // EXISTING label is not a creation and needs no confirmation — placing into
    // a rack that already exists stays one action.
    const label = rackRow.trim() ? `${rackNumber.trim()}-${rackRow.trim()}` : rackNumber.trim();
    const destination: Parameters<typeof bulkPlaceStockAction>[0]['destination'] = {
      newRack: {
        warehouseId,
        rackNumber: rackNumber.trim(),
        ...(rackRow.trim() ? { rackRow: rackRow.trim() } : {}),
      },
    };
    const decision = describeNewRackPlacement({
      label,
      warehouseName,
      quantity: totalUnits,
      existingLabels: destinations.map((d) => d.name),
      noun: 'rack',
    });
    if (decision.exists) {
      void place(destination);
      return;
    }
    setPendingNewRack({
      title: decision.title,
      message: decision.message,
      suggestions: decision.suggestions,
      destination,
    });
  }

  // "Did you mean 10-A?" — place into the EXISTING rack the worker probably
  // meant. The suggestion is an existing label; map it to that destination id.
  function placeIntoSuggestion(label: string) {
    const match = destinations.find(
      (d) => d.name.trim().toLowerCase() === label.trim().toLowerCase(),
    );
    if (!match) return;
    setPendingNewRack(null);
    void place({ existingLocationId: match.id });
  }

  async function place(destination: Parameters<typeof bulkPlaceStockAction>[0]['destination']) {
    setPendingNewRack(null);
    setSubmitting(true);
    const res = await bulkPlaceStockAction({
      placements: rows.map((r) => ({
        itemId: r.itemId,
        fromLocationId: r.sourceLocationId,
        quantity: r.quantity,
      })),
      notes: notes.trim() || undefined,
      destination,
    });
    setSubmitting(false);

    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }

    const { placed, failed } = res.data;
    if (failed.length === 0) {
      toast.success(`Placed ${placed} ${placed === 1 ? 'item' : 'items'}.`);
    } else if (placed > 0) {
      toast.warning(`Placed ${placed}, but ${failed.length} could not be placed.`);
    } else {
      toast.error('Nothing could be placed.');
    }
    setOpen(false);
    onPlaced();
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
                  <SelectItem value={NEW_RACK_SENTINEL}>+ New rack</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isNew && (
              <div className="grid grid-cols-2 gap-3 rounded-md border p-3">
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
            )}

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
        )}

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
              <Button onClick={() => void place(pendingNewRack.destination)} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <PackageCheck className="h-4 w-4" /> Create and place {rows.length}
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
