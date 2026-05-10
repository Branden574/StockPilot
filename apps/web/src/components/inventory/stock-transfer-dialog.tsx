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

interface LocationOption {
  id: string;
  name: string;
  warehouse_id: string | null;
}

interface StockTransferDialogProps {
  itemId: string;
  itemName: string;
  currentQuantity: number;
  currentLocationId: string | null;
  locations: LocationOption[];
  trigger?: React.ReactNode;
}

export function StockTransferDialog({
  itemId,
  itemName,
  currentQuantity,
  currentLocationId,
  locations,
  trigger,
}: StockTransferDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [fromLocation, setFromLocation] = React.useState<string>(currentLocationId ?? '');
  const [toLocation, setToLocation] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState('1');
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) setFromLocation(currentLocationId ?? '');
  }, [open, currentLocationId]);

  const qtyNum = Number.parseFloat(quantity) || 0;
  const validLocations = locations.filter((l) => l.id !== fromLocation);
  const fromLoc = locations.find((l) => l.id === fromLocation);
  const toLoc = locations.find((l) => l.id === toLocation);
  const crossWarehouse = !!fromLoc && !!toLoc && fromLoc.warehouse_id !== toLoc.warehouse_id;

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
    if (qtyNum > currentQuantity) {
      toast.error("Can't transfer more than the current on-hand stock.");
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

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>From location</Label>
            <Select value={fromLocation} onValueChange={setFromLocation}>
              <SelectTrigger>
                <SelectValue placeholder="Select source" />
              </SelectTrigger>
              <SelectContent>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
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
                {validLocations.map((l) => (
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

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Transfer stock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
