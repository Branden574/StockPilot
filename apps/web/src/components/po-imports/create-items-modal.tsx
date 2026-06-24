'use client';

import { AlertTriangle, Loader2, Plus, RotateCcw } from 'lucide-react';
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
import { formatCurrency, formatNumber } from '@/lib/utils';
import {
  createItemsFromPoLinesAction,
  findDuplicatesForPoLinesAction,
  type DuplicateCandidate,
} from '@/server/actions/po-imports';

import type { PoImportLineRow } from '@/server/services/po-imports';

interface CreateItemsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poImportId: string;
  vendorId: string;
  warehouseId: string | null;
  /** Optional charter the new items belong to. */
  charterId?: string | null;
  /** Optional specific location within the warehouse for the new items. */
  locationId?: string | null;
  /** Create the new items as products (default) or books. */
  itemType?: 'product' | 'book';
  /** PO lines the user is creating internal items from. */
  lines: PoImportLineRow[];
  /** Called after a successful create so the parent can refresh data. */
  onSuccess: (counts: {
    created: number;
    mapped: number;
    linked: number;
    skipped: number;
  }) => void;
}

type Decision =
  | { mode: 'create' }
  | { mode: 'use_existing'; itemId: string }
  | { mode: 'skip' };

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
  charterId,
  locationId,
  itemType,
  lines,
  onSuccess,
}: CreateItemsModalProps) {
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [decisions, setDecisions] = React.useState<Record<string, Decision>>({});
  const [duplicates, setDuplicates] = React.useState<Record<string, DuplicateCandidate[]>>({});
  const [scanning, setScanning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Reset the editable name map every time the modal opens with a new
  // set of lines so we don't carry stale edits between batches.
  React.useEffect(() => {
    if (!open) return;
    const seed: Record<string, string> = {};
    const seedDecisions: Record<string, Decision> = {};
    for (const l of lines) {
      const desc = (l.description ?? '').trim();
      seed[l.id] = autoCleanItemName(desc) || desc;
      seedDecisions[l.id] = { mode: 'create' };
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
    setNames(seed);
    setDecisions(seedDecisions);
    setDuplicates({});

    // Scan for duplicate candidates per line. Default decision flips to
    // 'use_existing' on a barcode-confidence match — barcode is the
    // manufacturer's part number, so a hit is essentially the same SKU.
    setScanning(true);
    findDuplicatesForPoLinesAction({
      poImportId,
      lineIds: lines.map((l) => l.id),
    })
      .then((r) => {
        if (!r.ok) {
          // Non-fatal — proceed without dedup hints.
          console.warn('duplicate scan failed', r.error.message);
          return;
        }
        setDuplicates(r.data.matches);
        setDecisions((prev) => {
          const next = { ...prev };
          for (const [lineId, list] of Object.entries(r.data.matches)) {
            const barcodeHit = list.find((c) => c.matchType === 'barcode');
            if (barcodeHit) {
              next[lineId] = { mode: 'use_existing', itemId: barcodeHit.id };
            }
          }
          return next;
        });
      })
      .finally(() => setScanning(false));
  }, [open, lines, poImportId]);

  function resetToCleaned(lineId: string) {
    const l = lines.find((x) => x.id === lineId);
    if (!l) return;
    const desc = (l.description ?? '').trim();
    setNames((m) => ({ ...m, [lineId]: autoCleanItemName(desc) || desc }));
  }

  function setDecision(lineId: string, decision: Decision) {
    setDecisions((m) => ({ ...m, [lineId]: decision }));
  }

  async function submit() {
    // Validate: every line in 'create' mode needs a non-empty name.
    const blank = lines.find(
      (l) => decisions[l.id]?.mode === 'create' && !(names[l.id] ?? '').trim(),
    );
    if (blank) {
      toast.error(`Line ${blank.line_number} needs a name before creating items.`);
      return;
    }
    // Validate: lines in 'use_existing' need an itemId.
    const unmappedLink = lines.find((l) => {
      const d = decisions[l.id];
      return d?.mode === 'use_existing' && !d.itemId;
    });
    if (unmappedLink) {
      toast.error(`Line ${unmappedLink.line_number} is set to use existing, but no item was picked.`);
      return;
    }
    setBusy(true);
    const r = await createItemsFromPoLinesAction({
      poImportId,
      lineIds: lines.map((l) => l.id),
      vendorId,
      warehouseId,
      charterId: charterId ?? null,
      locationId: locationId ?? null,
      itemType: itemType ?? 'product',
      nameOverrides: Object.fromEntries(
        Object.entries(names).map(([id, n]) => [id, n.trim()]),
      ),
      decisions: Object.fromEntries(
        Object.entries(decisions).map(([id, d]) => [
          id,
          d.mode === 'use_existing'
            ? { mode: 'use_existing' as const, itemId: d.itemId }
            : { mode: d.mode },
        ]),
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

  // Footer counts: tell the user what will actually happen on submit.
  let createCount = 0;
  let linkCount = 0;
  let skipCount = 0;
  for (const l of lines) {
    const d = decisions[l.id];
    if (d?.mode === 'use_existing') linkCount++;
    else if (d?.mode === 'skip') skipCount++;
    else createCount++;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className="flex h-[90vh] max-h-[90vh] w-[calc(100vw-2rem)] max-w-[1100px] flex-col overflow-hidden p-0 sm:w-[calc(100vw-3rem)]"
      >
        <DialogHeader className="border-border space-y-1 border-b px-6 pb-4 pt-6">
          <DialogTitle>
            Review {lines.length} {isSingle ? 'line' : 'lines'} from PO
          </DialogTitle>
          <p className="text-muted-foreground text-xs">
            Names are pre-filled from the PO description with the trailing part
            number stripped (it's already saved in the barcode field). When a
            row matches an existing inventory item by barcode or name, you'll
            see a yellow notice — pick "Use existing" to avoid duplicates, or
            "Create anyway" if it's actually a different SKU.
            {scanning && ' (scanning for matches…)'}
          </p>
        </DialogHeader>

        <div className="border-border bg-card divide-border mx-6 my-4 flex-1 divide-y overflow-y-auto rounded-md border text-sm">
          {lines.map((l) => {
            const original = (l.description ?? '').trim();
            const cleaned = autoCleanItemName(original) || original;
            const current = names[l.id] ?? cleaned;
            const isCleaned = current === cleaned;
            const dupes = duplicates[l.id] ?? [];
            const decision = decisions[l.id] ?? { mode: 'create' };

            return (
              <div key={l.id} className="space-y-2 p-3">
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

                {dupes.length > 0 && (
                  <div className="border-warning/40 bg-warning/5 space-y-2 rounded-md border px-2.5 py-2">
                    <div className="flex items-start gap-1.5 text-[11px]">
                      <AlertTriangle className="text-warning mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        Possible duplicate
                        {dupes.length === 1 ? '' : 's'} of an item already in
                        inventory:
                      </span>
                    </div>
                    {dupes.map((c) => {
                      const picked =
                        decision.mode === 'use_existing' && decision.itemId === c.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() =>
                            setDecision(l.id, { mode: 'use_existing', itemId: c.id })
                          }
                          disabled={busy}
                          className={
                            'flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ' +
                            (picked
                              ? 'border-foreground bg-foreground/5'
                              : 'border-border hover:border-foreground/60')
                          }
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">{c.name}</div>
                            <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-[10.5px]">
                              <span>{c.sku}</span>
                              {c.barcode && (
                                <>
                                  <span>·</span>
                                  <span>{c.barcode}</span>
                                </>
                              )}
                              <span>·</span>
                              <span>{formatNumber(c.quantityOnHand)} on hand</span>
                              <span>·</span>
                              <span className="uppercase tracking-wider">
                                {c.matchType === 'barcode'
                                  ? 'barcode match'
                                  : 'name match'}
                              </span>
                            </div>
                          </div>
                          <span className="text-[10.5px] uppercase tracking-wider">
                            {picked ? 'using' : 'use'}
                          </span>
                        </button>
                      );
                    })}
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      <Button
                        type="button"
                        size="sm"
                        variant={decision.mode === 'create' ? 'default' : 'ghost'}
                        className="h-6 text-[11px]"
                        onClick={() => setDecision(l.id, { mode: 'create' })}
                        disabled={busy}
                      >
                        Create anyway
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={decision.mode === 'skip' ? 'default' : 'ghost'}
                        className="h-6 text-[11px]"
                        onClick={() => setDecision(l.id, { mode: 'skip' })}
                        disabled={busy}
                      >
                        Skip line
                      </Button>
                    </div>
                  </div>
                )}

                {decision.mode === 'create' && (
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
                )}
                {decision.mode === 'create' && original !== current && (
                  <p className="text-muted-foreground truncate text-[11px]">
                    PO original: {original}
                  </p>
                )}
                {decision.mode === 'skip' && (
                  <p className="text-muted-foreground text-[11px] italic">
                    This line will be skipped — handle it later by mapping or
                    creating manually.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter className="border-border bg-background border-t px-6 py-4">
          <div className="text-muted-foreground mr-auto self-center text-[11px]">
            {createCount > 0 && <span>{createCount} new</span>}
            {createCount > 0 && (linkCount > 0 || skipCount > 0) && <span> · </span>}
            {linkCount > 0 && <span>{linkCount} linked</span>}
            {linkCount > 0 && skipCount > 0 && <span> · </span>}
            {skipCount > 0 && <span>{skipCount} skipped</span>}
          </div>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} variant="gradient">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
