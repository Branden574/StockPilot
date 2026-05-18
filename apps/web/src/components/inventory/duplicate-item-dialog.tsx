'use client';

import { Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
import { CRATE_COLORS } from '@/lib/book-storage';
import { duplicateItemAction } from '@/server/actions/duplicate-item';

interface Props {
  itemId: string;
  itemName: string;
  itemType: 'book' | 'product' | string | null;
}

/**
 * Modal launched by the "Duplicate" button on item-detail.
 * Pre-fills nothing visible (everything is inherited from the
 * original); user only enters the new physical location. On success,
 * redirects to the new item's detail page.
 */
export function DuplicateItemDialog({ itemId, itemName, itemType }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isBook = itemType === 'book';

  const [rackNumber, setRackNumber] = useState('');
  const [rackRow, setRackRow] = useState('');
  const [crateColor, setCrateColor] = useState('');
  const [crateNumber, setCrateNumber] = useState('');
  const [quantity, setQuantity] = useState('0');

  function reset() {
    setRackNumber('');
    setRackRow('');
    setCrateColor('');
    setCrateNumber('');
    setQuantity('0');
  }

  function submit() {
    const qty = Number.parseInt(quantity, 10);
    if (Number.isNaN(qty) || qty < 0) {
      toast.error('Quantity must be 0 or more.');
      return;
    }
    if (!rackNumber.trim()) {
      toast.error('Rack number is required.');
      return;
    }
    if (isBook && (!crateColor.trim() || !crateNumber.trim())) {
      toast.error('Crate color and number are required for books.');
      return;
    }

    startTransition(async () => {
      const input = isBook
        ? {
            originalId: itemId,
            itemType: 'book' as const,
            rackNumber: rackNumber.trim(),
            rackRow: rackRow.trim() || null,
            crateColor: crateColor.trim(),
            crateNumber: crateNumber.trim(),
            quantity: qty,
          }
        : {
            originalId: itemId,
            itemType: 'product' as const,
            rackNumber: rackNumber.trim(),
            rackRow: rackRow.trim() || null,
            quantity: qty,
          };
      const result = await duplicateItemAction(input);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(`Duplicated "${itemName}"`);
      setOpen(false);
      reset();
      router.push(`/dashboard/inventory/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="sm:size-auto">
          <Copy className="h-4 w-4" /> Duplicate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate {isBook ? 'book' : 'item'}</DialogTitle>
          <DialogDescription>
            Creates a second row of &ldquo;{itemName}&rdquo; at a new physical
            location. Everything else (name, SKU base, cost, photo, tags,
            category) is copied automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="dup-rack-number">Rack number</Label>
              <Input
                id="dup-rack-number"
                value={rackNumber}
                onChange={(e) => setRackNumber(e.target.value)}
                placeholder="38"
                disabled={pending}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="dup-rack-row">Row (optional)</Label>
              <Input
                id="dup-rack-row"
                value={rackRow}
                onChange={(e) => setRackRow(e.target.value)}
                placeholder="A"
                disabled={pending}
              />
            </div>
          </div>

          {isBook && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dup-crate-color">Crate color</Label>
                <Select
                  value={crateColor || undefined}
                  onValueChange={setCrateColor}
                  disabled={pending}
                >
                  <SelectTrigger id="dup-crate-color">
                    <SelectValue placeholder="Pick a color" />
                  </SelectTrigger>
                  <SelectContent>
                    {CRATE_COLORS.map((c) => (
                      <SelectItem key={c.slug} value={c.slug}>
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="border-border inline-block h-3 w-3 rounded-full border"
                            style={{ backgroundColor: c.hex }}
                          />
                          {c.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dup-crate-number">Crate number</Label>
                <Input
                  id="dup-crate-number"
                  value={crateNumber}
                  onChange={(e) => setCrateNumber(e.target.value)}
                  placeholder="4"
                  inputMode="numeric"
                  disabled={pending}
                />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="dup-quantity">Quantity at this rack</Label>
            <Input
              id="dup-quantity"
              type="number"
              inputMode="numeric"
              min={0}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={pending}
            />
            <p className="text-muted-foreground mt-1 text-xs">
              Defaults to 0. Set the actual on-hand count at the new rack.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
