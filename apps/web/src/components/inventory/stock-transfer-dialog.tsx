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
  trigger?: React.ReactNode;
}

export function StockTransferDialog({
  itemId,
  itemName,
  currentQuantity,
  locations,
  holdings,
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
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
    if (open) setFromLocation(sourceHoldings[0]?.locationId ?? '');
    // sourceHoldings is derived from holdings prop, which is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const qtyNum = Number.parseFloat(quantity) || 0;

  // Max transferable = the selected source holding's qty (not total on-hand)
  const selectedHolding = sourceHoldings.find((h) => h.locationId === fromLocation);
  const maxTransferable = selectedHolding?.quantity ?? 0;

  // Destination: all locations except the chosen source and system kinds
  const destinationLocations = locations.filter(
    (l) =>
      l.id !== fromLocation &&
      l.kind !== 'staging' &&
      l.kind !== 'unplaced',
  );

  const fromLoc = locations.find((l) => l.id === fromLocation);
  const toLoc = locations.find((l) => l.id === toLocation);
  const crossWarehouse = !!fromLoc && !!toLoc && fromLoc.warehouse_id !== toLoc.warehouse_id;

  const hasNoSources = sourceHoldings.length === 0;

  async function submit() {
    if (!fromLocation || !toLocation) {
      toast.error('Pick both a source and a destination location.');
      return;
    }
    if (fromLocation === toLocation) {
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
    setSubmitting(true);
    const res = await transferStockAction({
      itemId,
      fromLocationId: fromLocation,
      toLocationId: toLocation,
      quantity: qtyNum,
      notes: notes || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
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
              <Select value={fromLocation} onValueChange={setFromLocation}>
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
                </SelectContent>
              </Select>
              {crossWarehouse && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  This transfer crosses warehouses. Both warehouses must be in your access
                  scope.
                </p>
              )}
            </div>

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

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || hasNoSources}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Transfer stock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
