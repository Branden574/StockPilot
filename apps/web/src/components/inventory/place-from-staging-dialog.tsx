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
import { placeStockAction } from '@/server/actions/inventory';

const NEW_RACK_SENTINEL = '__new__';

interface DestinationOption {
  id: string;
  name: string;
  kind: string;
}

interface PlaceFromStagingDialogProps {
  itemId: string;
  itemName: string;
  itemType: string;
  stagingLocationId: string;
  warehouseId: string;
  stagedQuantity: number;
  destinations: DestinationOption[];
  trigger?: React.ReactNode;
}

export function PlaceFromStagingDialog({
  itemId,
  itemName,
  itemType,
  stagingLocationId,
  warehouseId,
  stagedQuantity,
  destinations,
  trigger,
}: PlaceFromStagingDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const [destId, setDestId] = React.useState<string>('');
  const [quantity, setQuantity] = React.useState(String(stagedQuantity));
  const [notes, setNotes] = React.useState('');

  // Inline new-rack/crate fields
  const [rackNumber, setRackNumber] = React.useState('');
  const [rackRow, setRackRow] = React.useState('');
  const [crateColor, setCrateColor] = React.useState('');
  const [crateNumber, setCrateNumber] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);

  const isBook = itemType === 'book';
  const isNew = destId === NEW_RACK_SENTINEL;

  // Reset form state whenever the dialog opens
  React.useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- reset all fields when dialog opens */
    setDestId('');
    setQuantity(String(stagedQuantity));
    setNotes('');
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const qtyNum = Number.parseInt(quantity, 10);
  const qtyValid = Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= stagedQuantity;

  const canSubmit =
    !submitting &&
    qtyValid &&
    (isNew ? rackNumber.trim().length > 0 : destId.length > 0);

  async function submit() {
    if (!qtyValid) {
      toast.error(`Quantity must be between 1 and ${stagedQuantity}.`);
      return;
    }

    let destination: Parameters<typeof placeStockAction>[0]['destination'];

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
          ...(isBook && crateColor.trim() ? { crateColor: crateColor.trim() } : {}),
          ...(isBook && crateNumber.trim() ? { crateNumber: crateNumber.trim() } : {}),
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
    const res = await placeStockAction({
      itemId,
      fromLocationId: stagingLocationId,
      quantity: qtyNum,
      notes: notes.trim() || undefined,
      destination,
    });
    setSubmitting(false);

    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }

    toast.success(`Placed ${qtyNum} ${qtyNum === 1 ? 'unit' : 'units'} of ${itemName}.`);
    setOpen(false);
    router.refresh();
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
          <DialogTitle>Place from staging</DialogTitle>
          <DialogDescription>
            Move <span className="font-medium text-foreground">{itemName}</span> from
            staging into a rack or crate. Staged:{' '}
            <span className="tabular-nums">{stagedQuantity}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Fixed source */}
          <div className="space-y-1.5">
            <Label>From</Label>
            <div className="bg-muted text-muted-foreground flex h-9 items-center rounded-md border px-3 text-sm">
              Staging
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
                (max {stagedQuantity})
              </span>
            </Label>
            <Input
              type="number"
              step="1"
              min="1"
              max={stagedQuantity}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            {quantity !== '' && !qtyValid && (
              <p className="text-destructive text-[11px]">
                Must be between 1 and {stagedQuantity}.
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

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Place stock'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
