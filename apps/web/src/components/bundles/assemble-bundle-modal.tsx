'use client';

import { Loader2, PackagePlus } from 'lucide-react';
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
import { assembleBundleAction } from '@/server/actions/bundles';

interface Props {
  bundleId: string;
  bundleName: string;
  warehouses: Array<{ id: string; name: string }>;
  /** If a phantom already exists, lock the warehouse to its current home. */
  lockedWarehouseId?: string | null;
}

export function AssembleBundleModal({
  bundleId,
  bundleName,
  warehouses,
  lockedWarehouseId,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [quantity, setQuantity] = React.useState('1');
  const [warehouseId, setWarehouseId] = React.useState(
    lockedWarehouseId ?? warehouses[0]?.id ?? '',
  );
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open && lockedWarehouseId) setWarehouseId(lockedWarehouseId);
  }, [open, lockedWarehouseId]);

  async function submit() {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Enter a positive quantity.');
      return;
    }
    if (!warehouseId) {
      toast.error('Pick a warehouse to assemble in.');
      return;
    }
    setBusy(true);
    const res = await assembleBundleAction({
      id: bundleId,
      quantity: qty,
      warehouseId,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      `Pre-assembled ${qty} ${bundleName} kit${qty === 1 ? '' : 's'}.`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <PackagePlus className="h-3.5 w-3.5" />
          Assemble more
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assemble {bundleName}</DialogTitle>
          <DialogDescription>
            Decrements the listed components and increments the phantom kit
            count by the chosen quantity.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assemble-qty">Quantity</Label>
            <Input
              id="assemble-qty"
              type="number"
              min={1}
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Warehouse</Label>
            <Select
              value={warehouseId}
              onValueChange={setWarehouseId}
              disabled={busy || Boolean(lockedWarehouseId)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {lockedWarehouseId && (
              <p className="text-muted-foreground text-[11.5px]">
                Locked — existing pre-assembled kits live at this warehouse.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assemble-notes">Notes (optional)</Label>
            <Textarea
              id="assemble-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Why this assembly batch, who it's for, etc."
              disabled={busy}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="gradient" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Assemble
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
