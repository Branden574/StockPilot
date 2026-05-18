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

type SizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';
const ALL_SIZES: ReadonlyArray<SizeCode> = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];

// Note: alternation order matters — list longest-first so the engine
// prefers `XXXXL` over `XXXL`, etc., and `XS` over `S` (otherwise
// "L4L Tee XS" would match `S` and leave a trailing `X` on the base).
const SIZE_NAME_REGEX = /(?:\s*-\s*|\s+)(?:XXXXL|XXXL|XXL|XL|XS|L|M|S)\s*$/i;
const SIZE_SKU_REGEX = /-(?:XXXXL|XXXL|XXL|XL|XS|L|M|S)$/i;

/**
 * Strip a trailing size suffix from a name so we can pre-fill the base
 * for "Add more sizes". Handles ' - S', '- S', and a bare trailing size
 * token (e.g. "L4L Grey Quarter Zip Men's XXL"). Returns the original
 * string when no recognized suffix is present.
 */
function stripSizeSuffix(s: string): string {
  return s.replace(SIZE_NAME_REGEX, '').trim();
}

/**
 * Strip a trailing size suffix from a SKU — BUT only when the name had
 * a recognized size suffix too. Auto-generated SKUs are random base36
 * and can coincidentally end in `-L`/`-M`/`-S` even when the item isn't
 * sized; without the name-side check we'd mangle e.g. "SP-OKX68-UAL"
 * into "SP-OKX68-UA". Tying it to the name keeps the heuristic safe:
 * if the source item's name doesn't look sized, leave the SKU alone.
 */
function stripSkuSuffix(sku: string | null, name: string): string | null {
  if (!sku) return null;
  if (!SIZE_NAME_REGEX.test(name)) return sku;
  return sku.replace(SIZE_SKU_REGEX, '');
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
    charterId: string | null;
    primaryLocationId: string | null;
    binLocation: string | null;
    retailPrice: number;
    unitCost: number;
    reorderPoint: number;
    reorderQuantity: number;
    unitOfMeasure: string;
    /**
     * Item type of the source row. Drives post-submit routing so the
     * user lands back on the same tab they started on — books go to
     * /dashboard/books, everything else to /dashboard/inventory.
     */
    itemType?: 'product' | 'book' | 'asset' | 'consumable';
  };
}

export function AddSizedVariantsButton({ source }: AddSizedVariantsButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [baseName, setBaseName] = React.useState(stripSizeSuffix(source.name));
  const [baseSku, setBaseSku] = React.useState<string>(
    stripSkuSuffix(source.sku, source.name) ?? '',
  );
  const [selected, setSelected] = React.useState<
    Array<{ size: SizeCode; quantity: number }>
  >([]);

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setBaseName(stripSizeSuffix(source.name));
      setBaseSku(stripSkuSuffix(source.sku, source.name) ?? '');
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
    try {
      const res = await bulkCreateSizedVariantsAction({
        baseName: baseName.trim(),
        baseSku: baseSku.trim() || null,
        baseBarcode: source.barcode,
        description: source.description,
        categoryId: source.categoryId,
        supplierId: source.supplierId,
        warehouseId: source.warehouseId,
        charterId: source.charterId,
        primaryLocationId: source.primaryLocationId,
        binLocation: source.binLocation,
        retailPrice: source.retailPrice,
        unitCost: source.unitCost,
        reorderPoint: source.reorderPoint,
        reorderQuantity: source.reorderQuantity,
        unitOfMeasure: source.unitOfMeasure,
        variants: selected,
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success(
        `Created ${res.data.created} variant${res.data.created === 1 ? '' : 's'}.`,
      );
      setOpen(false);
      // Route back to the tab the source item lives on. Books have
      // their own /dashboard/books page; everything else funnels to
      // /dashboard/inventory.
      router.push(source.itemType === 'book' ? '/dashboard/books' : '/dashboard/inventory');
    } finally {
      setBusy(false);
    }
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
                    aria-pressed={picked}
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
