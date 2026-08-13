'use client';

import { Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  APPAREL_ALPHA_SIZES,
  placementWarningMessage,
  stripSizeSuffix,
  stripSkuSuffix,
  type ApparelAlphaSize,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { resolveListReturnHref } from '@/lib/last-list-url';
import { cn } from '@/lib/utils';
import { bulkCreateSizedVariantsAction } from '@/server/actions/inventory';

// One list, in @stockpilot/core (`inventory/apparel-sizes`), shared with the
// item form and the native size run. See that file for why the nine canonical
// letters are offered and the apparel_alpha scale's 14-row alias union is not.
type SizeCode = ApparelAlphaSize;
const ALL_SIZES: ReadonlyArray<SizeCode> = APPAREL_ALPHA_SIZES;

// Size parsing (stripSizeSuffix / stripSkuSuffix) now lives in @stockpilot/core
// (`inventory/size-run`), shared with the inventory-list size-run grouping. That
// shared copy also recognizes 2XL/3XL/4XL/5XL, which this private copy did not.

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
    /** Omit to let the server take the category's counting unit. */
    unitOfMeasure?: string;
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
  const [selected, setSelected] = React.useState<Array<{ size: SizeCode; quantity: number }>>([]);

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
      const lead = `Created ${res.data.created} variant${res.data.created === 1 ? '' : 's'}`;
      if (res.data.placementFailed) {
        // This entry point inherits `binLocation` from the SOURCE item rather
        // than a freshly typed rack, which makes a silent miss even easier to
        // overlook: the operator never typed the rack, so they have no reason
        // to go and check it.
        toast.warning(placementWarningMessage(lead, res.data.placementFailed), {
          duration: 10000,
        });
      } else {
        toast.success(`${lead}.`);
      }
      setOpen(false);
      // Route back to the tab the source item lives on, preserving
      // the page / search / filter state the user was on (read from
      // sessionStorage, written by the list table on every render).
      // Books have their own /dashboard/books page; everything else
      // funnels to /dashboard/inventory.
      const basePath = source.itemType === 'book' ? '/dashboard/books' : '/dashboard/inventory';
      router.push(resolveListReturnHref(basePath, null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Add more sizes
      </Button>
      <Dialog open={open} onOpenChange={(v) => (busy ? null : setOpen(v))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add sized variants</DialogTitle>
            <DialogDescription>
              Creates one new inventory row per size you pick, copying the supplier, category,
              warehouse, prices, and reorder thresholds from this item. This item stays unchanged.
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
                Base SKU <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
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
                      'border-border rounded border px-2.5 py-1 text-xs transition-colors',
                      picked ? 'bg-foreground text-background' : 'hover:bg-muted',
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
                    <BlankZeroNumberInput
                      min={0}
                      value={entry.quantity}
                      onValueChange={(n) =>
                        setSelected((prev) => {
                          const next = [...prev];
                          next[i] = { ...entry, quantity: n };
                          return next;
                        })
                      }
                      className="h-8 w-24"
                    />
                    <span className="text-muted-foreground text-[11px]">on hand</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
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
