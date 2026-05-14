'use client';

import { Loader2, Plus } from 'lucide-react';
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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { bulkCreateSizedVariantsAction } from '@/server/actions/inventory';

type SizeCode = 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
const ALL_SIZES: ReadonlyArray<SizeCode> = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];

/**
 * Strip a trailing size suffix from a name so we can pre-fill the base
 * for "Add more sizes". Handles ' - S', '- S', and a bare trailing size
 * token (e.g. "L4L Grey Quarter Zip Men's XXL").
 */
function stripSizeSuffix(s: string): string {
  return s
    .replace(/\s*-\s*(?:XXXXL|XXXL|XXL|XL|L|M|S)\s*$/i, '')
    .replace(/\s+(?:XXXXL|XXXL|XXL|XL|L|M|S)\s*$/i, '')
    .trim();
}

function stripSkuSuffix(s: string | null): string | null {
  if (!s) return null;
  return s.replace(/-(?:XXXXL|XXXL|XXL|XL|L|M|S)$/i, '');
}

export interface AddSizedVariantsButtonProps {
  /** Base values pulled from the item currently being edited. */
  source: {
    name: string;
    sku: string | null;
    barcode: string | null;
    description: string | null;
    categoryId: string;
    supplierId: string | null;
    warehouseId: string;
    primaryLocationId: string | null;
    binLocation: string | null;
    retailPrice: number;
    unitCost: number;
    reorderPoint: number;
    reorderQuantity: number;
  };
}

export function AddSizedVariantsButton({ source }: AddSizedVariantsButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [baseName, setBaseName] = React.useState(stripSizeSuffix(source.name));
  const [baseSku, setBaseSku] = React.useState<string>(stripSkuSuffix(source.sku) ?? '');
  const [selected, setSelected] = React.useState<
    Array<{ size: SizeCode; quantity: number }>
  >([]);

  React.useEffect(() => {
    if (open) {
      setBaseName(stripSizeSuffix(source.name));
      setBaseSku(stripSkuSuffix(source.sku) ?? '');
      setSelected([]);
    }
  }, [open, source.name, source.sku]);

  async function apply() {
    if (selected.length === 0) {
      toast.error('Pick at least one size.');
      return;
    }
    if (!baseName.trim()) {
      toast.error('Base name is required.');
      return;
    }
    setBusy(true);
    const res = await bulkCreateSizedVariantsAction({
      baseName: baseName.trim(),
      baseSku: baseSku.trim() || null,
      baseBarcode: source.barcode,
      description: source.description,
      categoryId: source.categoryId,
      supplierId: source.supplierId,
      warehouseId: source.warehouseId,
      primaryLocationId: source.primaryLocationId,
      binLocation: source.binLocation,
      retailPrice: source.retailPrice,
      unitCost: source.unitCost,
      reorderPoint: source.reorderPoint,
      reorderQuantity: source.reorderQuantity,
      variants: selected,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      `Created ${res.data.created} variant${res.data.created === 1 ? '' : 's'}.`,
    );
    setOpen(false);
    router.push('/dashboard/inventory');
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" /> Add more sizes
      </Button>
      <Dialog open={open} onOpenChange={(v) => (busy ? null : setOpen(v))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add sized variants</DialogTitle>
            <DialogDescription>
              Creates one new inventory row per size you pick, copying the
              supplier, category, warehouse, prices, and reorder thresholds
              from this item. This item stays unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-base-name">Base name</Label>
              <Input
                id="add-base-name"
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
              />
              <p className="text-muted-foreground text-[11px]">
                Each variant becomes &quot;{baseName.trim() || 'Name'} - {'{Size}'}&quot;.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-base-sku">
                Base SKU{' '}
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="add-base-sku"
                value={baseSku}
                onChange={(e) => setBaseSku(e.target.value)}
              />
              <p className="text-muted-foreground text-[11px]">
                Each variant becomes &quot;{baseSku.trim() || '—'}-{'{Size}'}&quot;.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Sizes</Label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_SIZES.map((s) => {
                const picked = selected.some((x) => x.size === s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() =>
                      setSelected((prev) =>
                        picked
                          ? prev.filter((x) => x.size !== s)
                          : [...prev, { size: s, quantity: 0 }],
                      )
                    }
                    className={cn(
                      'rounded border border-border px-2.5 py-1 text-xs transition-colors',
                      picked
                        ? 'bg-foreground text-background'
                        : 'hover:bg-muted',
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            {selected.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {selected.map((entry, i) => (
                  <div key={entry.size} className="flex items-center gap-2">
                    <span className="w-10 text-xs font-medium">{entry.size}</span>
                    <Input
                      type="number"
                      min={0}
                      value={entry.quantity}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = [...prev];
                          next[i] = {
                            ...entry,
                            quantity: Number(e.target.value) || 0,
                          };
                          return next;
                        })
                      }
                      className="h-8 w-24"
                    />
                    <span className="text-muted-foreground text-[11px]">
                      on hand
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={apply} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create variants'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
