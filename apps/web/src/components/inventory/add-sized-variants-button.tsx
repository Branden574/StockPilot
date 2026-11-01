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
  type NewRackConfirmationDetail,
} from '@stockpilot/core';

import { newRackConfirmContent, newRackQuestion } from '@/components/inventory/new-rack-question';
import { PlacementConfirmDialog } from '@/components/inventory/placement-confirm-dialog';
import { touchTargetClass } from '@/components/patterns/touch-target';
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
  // "Create new rack 1-B?" (2026-10-24): the new sizes inherit this item's rack
  // label, and when no such rack exists the server asks before it creates one,
  // the same question as the New item form (see new-rack-question.ts).
  const [rackQuestion, setRackQuestion] = React.useState<NewRackConfirmationDetail | null>(null);

  React.useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setBaseName(stripSizeSuffix(source.name));
      setBaseSku(stripSkuSuffix(source.sku, source.name) ?? '');
      setSelected([]);
      setRackQuestion(null);
    }
  }, [open, source.name, source.sku]);

  /**
   * `answer` is the person's reply to the server's new-rack question, for this
   * one save: yes, or the near-match to put the stock on instead.
   */
  async function apply(answer: { confirmNewRack?: true; binLocation?: string } = {}) {
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
        binLocation: answer.binLocation ?? source.binLocation,
        retailPrice: source.retailPrice,
        unitCost: source.unitCost,
        reorderPoint: source.reorderPoint,
        reorderQuantity: source.reorderQuantity,
        unitOfMeasure: source.unitOfMeasure,
        variants: selected,
        // Only after the person said yes to creating the new rack.
        ...(answer.confirmNewRack ? { confirmNewRack: true } : {}),
      });
      if (!res.ok) {
        const question = newRackQuestion(res.error);
        setRackQuestion(question);
        if (question) return;
        toast.error(res.error.message);
        return;
      }
      setRackQuestion(null);
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
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-base-name">Base name</Label>
              <Input
                id="add-base-name"
                value={baseName}
                onChange={(e) => setBaseName(e.target.value)}
              />
              <p className="text-muted-foreground text-[12px] leading-[17px]">
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
              <p className="text-muted-foreground text-[12px] leading-[17px]">
                Each variant becomes &quot;{baseSku.trim() || '—'}-{'{Size}'}&quot;.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label id="add-sizes-label">Sizes</Label>
            <div role="group" aria-labelledby="add-sizes-label" className="flex flex-wrap gap-2">
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
                    // The form's size chip: the filter-chip recipe, ink when
                    // picked, 44 px on a phone and the shared chip's touch area
                    // on a coarse pointer (the row's gap-2 keeps them apart).
                    className={cn(
                      touchTargetClass,
                      'inline-flex h-7 min-w-9 items-center justify-center rounded-full border px-3 font-mono text-[12.5px] transition-colors max-sm:h-11 max-sm:min-w-11',
                      picked
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-line-strong text-ink-2 hover:bg-muted hover:text-foreground',
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
                    <span className="w-10 font-mono text-[12.5px] font-medium">{entry.size}</span>
                    <BlankZeroNumberInput
                      aria-label={`On hand for size ${entry.size}`}
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
                    <span className="text-muted-foreground text-[12px]">on hand</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void apply()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create variants'}
            </Button>
          </DialogFooter>
        </DialogContent>

        <PlacementConfirmDialog
          open={rackQuestion !== null}
          content={rackQuestion ? newRackConfirmContent(rackQuestion) : null}
          submitting={busy}
          onCancel={() => setRackQuestion(null)}
          onConfirm={() => void apply({ confirmNewRack: true })}
          onUseSuggestion={(label) => void apply({ binLocation: label })}
        />
      </Dialog>
    </>
  );
}
