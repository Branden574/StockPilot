'use client';

import { Loader2, PackageCheck } from 'lucide-react';
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
  /** Called after a successful (full or partial) place so the parent can clear selection. */
  onPlaced: () => void;
  trigger: React.ReactNode;
}

export function BulkPlaceDialog({ rows, destinationsMap, onPlaced, trigger }: BulkPlaceDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const [destId, setDestId] = React.useState<string>('');
  const [notes, setNotes] = React.useState('');
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

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

  const totalUnits = rows.reduce((s, r) => s + r.quantity, 0);
  const isNew = destId === NEW_RACK_SENTINEL;

  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset fields on open */
    setDestId('');
    setNotes('');
    setRackNumber('');
    setRackRow('');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  const canSubmit =
    !submitting &&
    singleWarehouse &&
    rows.length > 0 &&
    (isNew ? rackNumber.trim().length > 0 : destId.length > 0);

  async function submit() {
    if (!warehouseId) {
      toast.error('Select items from a single warehouse to place them together.');
      return;
    }

    let destination: Parameters<typeof bulkPlaceStockAction>[0]['destination'];
    if (isNew) {
      if (!rackNumber.trim()) {
        toast.error('Enter a rack number.');
        return;
      }
      destination = {
        newRack: {
          warehouseId,
          rackNumber: rackNumber.trim(),
          ...(rackRow.trim() ? { rackRow: rackRow.trim() } : {}),
        },
      };
    } else {
      if (!destId) {
        toast.error('Select a destination location.');
        return;
      }
      destination = { existingLocationId: destId };
    }

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
    </Dialog>
  );
}
