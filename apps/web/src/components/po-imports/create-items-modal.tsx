'use client';

import { Loader2, Plus, RotateCcw } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatCurrency } from '@/lib/utils';
import { createItemsFromPoLinesAction } from '@/server/actions/po-imports';

import type { PoImportLineRow } from '@/server/services/po-imports';

interface CreateItemsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poImportId: string;
  vendorId: string;
  warehouseId: string | null;
  /** PO lines the user is creating internal items from. */
  lines: PoImportLineRow[];
  /** Called after a successful create so the parent can refresh data. */
  onSuccess: (counts: { created: number; mapped: number }) => void;
}

/**
 * Strip the trailing "(SOMETHING)" off a PO line description. The
 * manufacturer's part number already lives in the barcode field, so
 * keeping it in the name is just clutter.
 *
 *   "Duracell Coppertop AA Alkaline Batteries, 24/Pack (MN1500B240001)"
 *   → "Duracell Coppertop AA Alkaline Batteries, 24/Pack"
 */
export function autoCleanItemName(description: string): string {
  return description.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function CreateItemsModal({
  open,
  onOpenChange,
  poImportId,
  vendorId,
  warehouseId,
  lines,
  onSuccess,
}: CreateItemsModalProps) {
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  // Reset the editable name map every time the modal opens with a new
  // set of lines so we don't carry stale edits between batches.
  React.useEffect(() => {
    if (!open) return;
    const seed: Record<string, string> = {};
    for (const l of lines) {
      const desc = (l.description ?? '').trim();
      seed[l.id] = autoCleanItemName(desc) || desc;
    }
    setNames(seed);
  }, [open, lines]);

  function resetToCleaned(lineId: string) {
    const l = lines.find((x) => x.id === lineId);
    if (!l) return;
    const desc = (l.description ?? '').trim();
    setNames((m) => ({ ...m, [lineId]: autoCleanItemName(desc) || desc }));
  }

  async function submit() {
    // Validate: every name must be non-empty.
    const blank = lines.find((l) => !(names[l.id] ?? '').trim());
    if (blank) {
      toast.error(`Line ${blank.line_number} needs a name`);
      return;
    }
    setBusy(true);
    const r = await createItemsFromPoLinesAction({
      poImportId,
      lineIds: lines.map((l) => l.id),
      vendorId,
      warehouseId,
      nameOverrides: Object.fromEntries(
        Object.entries(names).map(([id, n]) => [id, n.trim()]),
      ),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    onSuccess(r.data);
    onOpenChange(false);
  }

  const isSingle = lines.length === 1;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Create {lines.length} new {isSingle ? 'item' : 'items'} from PO
          </DialogTitle>
        </DialogHeader>

        <p className="text-muted-foreground text-xs">
          Names are pre-filled from the PO description with the trailing part
          number stripped (it's already saved in the barcode field). Tweak
          anything before saving — the manufacturer code, vendor #, unit cost,
          and supplier carry over from the PO.
        </p>

        <div className="border-border bg-card divide-border divide-y rounded-md border text-sm">
          {lines.map((l) => {
            const original = (l.description ?? '').trim();
            const cleaned = autoCleanItemName(original) || original;
            const current = names[l.id] ?? cleaned;
            const isCleaned = current === cleaned;
            return (
              <div key={l.id} className="space-y-1.5 p-3">
                <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
                  <span className="font-mono">Line {l.line_number}</span>
                  <span>·</span>
                  <span className="tabular-nums">
                    {l.qty_ordered_original} {l.uom_original}
                  </span>
                  <span>·</span>
                  <span className="tabular-nums">
                    {l.unit_cost != null ? formatCurrency(l.unit_cost) : '—'} unit
                  </span>
                  {l.vendor_item_number && (
                    <>
                      <span>·</span>
                      <span className="font-mono">vendor #{l.vendor_item_number}</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={current}
                    onChange={(e) =>
                      setNames((m) => ({ ...m, [l.id]: e.target.value }))
                    }
                    placeholder="Item name"
                    maxLength={200}
                    disabled={busy}
                  />
                  {!isCleaned && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => resetToCleaned(l.id)}
                      disabled={busy}
                      title="Reset to auto-cleaned PO description"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {original !== current && (
                  <p className="text-muted-foreground truncate text-[11px]">
                    PO original: {original}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} variant="gradient">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create {lines.length} {isSingle ? 'item' : 'items'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
