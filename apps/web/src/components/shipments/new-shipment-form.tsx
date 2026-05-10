'use client';

import { Loader2, Package, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { manualCreateShipmentAction } from '@/server/actions/shipments';

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

interface CharterOption {
  id: string;
  name: string;
  code: string | null;
}

interface WarehouseCharterPair {
  warehouse_id: string;
  charter_id: string;
}

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  /** The item's home warehouse — used to filter the browse list. */
  warehouseId: string | null;
  /** Org-wide on-hand. When a source warehouse is selected, this is the
   * on-hand AT that warehouse (because the item's warehouse_id IS its
   * home warehouse, and inventory_items.quantity_on_hand is the per-row
   * count for that home location). */
  quantityOnHand: number;
}

interface FormValues {
  attentionToName: string;
  notes: string;
  ccEmails: string;
}

interface LineRow {
  itemId: string;
  qtyShipped: number;
  qtyBackOrdered: number;
}

export function NewShipmentForm({
  sourceWarehouses,
  charters,
  warehouseCharterPairs,
  items,
}: {
  sourceWarehouses: WarehouseOption[];
  charters: CharterOption[];
  warehouseCharterPairs: WarehouseCharterPair[];
  items: ItemOption[];
}) {
  const router = useRouter();
  const [sourceWarehouseId, setSourceWarehouseId] = React.useState<string>(
    () => sourceWarehouses[0]?.id ?? '',
  );
  const [destinationCharterId, setDestinationCharterId] =
    React.useState<string>('');
  const [lines, setLines] = React.useState<LineRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { attentionToName: '', notes: '', ccEmails: '' },
  });

  // Build a map item.id → ItemOption once for row-render lookups.
  const itemMap = React.useMemo(() => {
    const m = new Map<string, ItemOption>();
    for (const i of items) m.set(i.id, i);
    return m;
  }, [items]);

  // Pairs indexed by warehouse_id for O(1) lookup of charter ids.
  const chartersByWarehouse = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of warehouseCharterPairs) {
      const set = m.get(p.warehouse_id) ?? new Set<string>();
      set.add(p.charter_id);
      m.set(p.warehouse_id, set);
    }
    return m;
  }, [warehouseCharterPairs]);

  // Filter charters by the selected source warehouse (warehouse_charters).
  // Falls back to an empty list if no source is picked.
  const filteredCharters = React.useMemo(() => {
    if (!sourceWarehouseId) return [] as CharterOption[];
    const allowed = chartersByWarehouse.get(sourceWarehouseId);
    if (!allowed || allowed.size === 0) return [];
    return charters.filter((c) => allowed.has(c.id));
  }, [charters, chartersByWarehouse, sourceWarehouseId]);

  // When the source changes, reset the charter selection — the previously
  // chosen charter may not be in the new warehouse's service list.
  React.useEffect(() => {
    if (
      destinationCharterId &&
      !filteredCharters.some((c) => c.id === destinationCharterId)
    ) {
      setDestinationCharterId('');
    }
  }, [filteredCharters, destinationCharterId]);

  // Items at the selected source warehouse. inventory_items.warehouse_id
  // IS the item's home warehouse, and quantity_on_hand is the count at
  // that home; that gives us per-source-warehouse on-hand for free without
  // joining item_stock_levels.
  const itemsAtSource = React.useMemo(() => {
    if (!sourceWarehouseId) return [] as ItemOption[];
    return items.filter((i) => i.warehouseId === sourceWarehouseId);
  }, [items, sourceWarehouseId]);

  function addItem(itemId: string) {
    setLines((prev) => {
      // If the item is already on the slip, just bump qty by 1 instead
      // of adding a duplicate row. (Same dedupe semantics the search-based
      // picker used to have.)
      const existing = prev.findIndex((l) => l.itemId === itemId);
      if (existing !== -1) {
        return prev.map((l, i) =>
          i === existing ? { ...l, qtyShipped: l.qtyShipped + 1 } : l,
        );
      }
      return [...prev, { itemId, qtyShipped: 1, qtyBackOrdered: 0 }];
    });
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  const onSubmit = handleSubmit(async (values) => {
    if (!sourceWarehouseId) {
      toast.error('Pick a source warehouse');
      return;
    }
    if (!destinationCharterId) {
      toast.error('Pick a destination charter');
      return;
    }
    if (lines.length === 0) {
      toast.error('Add at least one line item');
      return;
    }
    if (lines.some((l) => l.qtyShipped <= 0 && l.qtyBackOrdered <= 0)) {
      toast.error('Every line needs a non-zero shipped or back-ordered qty');
      return;
    }

    const ccList = values.ccEmails
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setSubmitting(true);
    const res = await manualCreateShipmentAction({
      sourceWarehouseId,
      destinationCharterId,
      attentionToName: values.attentionToName.trim()
        ? values.attentionToName.trim()
        : null,
      notes: values.notes.trim() ? values.notes.trim() : null,
      ccEmails: ccList.length > 0 ? ccList : undefined,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        qtyShipped: l.qtyShipped,
        qtyBackOrdered: l.qtyBackOrdered,
      })),
    });
    setSubmitting(false);

    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Shipment draft created');
    router.push(`/dashboard/shipments/${res.data.id}`);
  });

  const canSubmit =
    !!sourceWarehouseId && !!destinationCharterId && lines.length > 0;

  const selectedSource = sourceWarehouses.find((w) => w.id === sourceWarehouseId);

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="source-wh">Source warehouse</Label>
          <Select value={sourceWarehouseId} onValueChange={setSourceWarehouseId}>
            <SelectTrigger id="source-wh">
              <SelectValue placeholder="Pick a source warehouse" />
            </SelectTrigger>
            <SelectContent>
              {sourceWarehouses.length === 0 && (
                <SelectItem value="__none" disabled>
                  No writable warehouses
                </SelectItem>
              )}
              {sourceWarehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}{' '}
                  <span className="text-muted-foreground text-xs">({w.code})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sourceWarehouses.length === 0 && (
            <p className="text-muted-foreground text-xs">
              You don&apos;t have write access to any warehouse — can&apos;t
              create a shipment.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dest-charter">Destination charter</Label>
          <Select
            value={destinationCharterId}
            onValueChange={setDestinationCharterId}
            disabled={!sourceWarehouseId || filteredCharters.length === 0}
          >
            <SelectTrigger id="dest-charter">
              <SelectValue placeholder="Pick a destination charter" />
            </SelectTrigger>
            <SelectContent>
              {filteredCharters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.code ? (
                    <span className="text-muted-foreground text-xs"> ({c.code})</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sourceWarehouseId && filteredCharters.length === 0 && (
            <p className="text-muted-foreground text-xs">
              This warehouse doesn&apos;t service any charters yet. Add charter
              assignments in Admin → Warehouses.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="attention">Attention to (optional)</Label>
        <Input
          id="attention"
          maxLength={200}
          placeholder="Principal, receiving clerk, etc."
          {...register('attentionToName')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          rows={3}
          maxLength={2000}
          placeholder="Anything the receiver needs to know"
          {...register('notes')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cc">CC emails (optional)</Label>
        <Input
          id="cc"
          placeholder="principal@school.org, ops@charter.org"
          {...register('ccEmails')}
        />
        <p className="text-muted-foreground text-[11px]">
          Comma-separated. Used by the Phase 2B signed-PDF email.
        </p>
        {errors.ccEmails && (
          <p className="text-destructive text-xs">{errors.ccEmails.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label>Line items</Label>
        {/*
         * Browseable two-pane picker. The left pane lists every active item
         * at the chosen source warehouse — click a row to add it (or bump
         * its qty if it's already on the slip). The right pane is the
         * current slip. Search is a polish filter, not a requirement:
         * the goal is "see books properly" without forcing a keyword.
         */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ItemBrowsePane
            items={itemsAtSource}
            sourceWarehouseName={selectedSource?.name ?? null}
            onPick={addItem}
          />
          <ShipmentLinesPane
            lines={lines}
            itemMap={itemMap}
            onUpdate={updateLine}
            onRemove={removeLine}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="gradient"
          disabled={submitting || !canSubmit}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Create shipment'
          )}
        </Button>
      </div>
    </form>
  );
}

/**
 * Browseable list of items at the source warehouse. The whole row is the
 * click target so adding items is unambiguous (no "tiny button to aim at"
 * problem). Optional in-list search filters the visible rows but the
 * scrollable list is the primary affordance — users should never NEED
 * to search to find a book.
 */
function ItemBrowsePane({
  items,
  sourceWarehouseName,
  onPick,
}: {
  items: ItemOption[];
  sourceWarehouseName: string | null;
  onPick: (itemId: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const trimmed = query.trim().toLowerCase();

  const visible = React.useMemo(() => {
    if (trimmed.length === 0) return items;
    return items.filter((i) => {
      const hay = `${i.name} ${i.sku} ${i.barcode ?? ''}`.toLowerCase();
      return hay.includes(trimmed);
    });
  }, [items, trimmed]);

  return (
    <div className="bg-card flex flex-col overflow-hidden rounded-md border">
      <div className="border-border space-y-1.5 border-b px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Available items
          {sourceWarehouseName ? (
            <span className="text-foreground/80 ml-1 normal-case tracking-normal">
              at {sourceWarehouseName}
            </span>
          ) : null}
        </p>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type to filter…"
          className="h-8 text-sm"
        />
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
            <Package className="h-5 w-5 opacity-60" />
            <p>
              {sourceWarehouseName
                ? 'No active items at this warehouse yet.'
                : 'Pick a source warehouse to see available items.'}
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-muted-foreground px-4 py-6 text-center text-xs">
            No matches for &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {visible.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => onPick(i.id)}
                  className="hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus:outline-none"
                >
                  <ItemThumb />
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground font-mono text-[11px]">
                      {i.sku}
                    </p>
                    <p className="truncate text-sm font-medium">{i.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-foreground tabular-nums text-sm font-medium">
                      {i.quantityOnHand}
                    </p>
                    <p className="text-muted-foreground text-[10px] uppercase tracking-wider">
                      on hand
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {items.length > 0 && (
        <div className="border-border bg-muted/30 text-muted-foreground border-t px-3 py-1.5 text-[11px]">
          Showing {visible.length} of {items.length} items
        </div>
      )}
    </div>
  );
}

/**
 * No `image_url` is surfaced by InventoryService.list today, so the thumb
 * is a brand-styled placeholder. Once item images land on the list query
 * this becomes an <Image src=… />.
 */
function ItemThumb() {
  return (
    <div className="bg-muted text-muted-foreground/70 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md">
      <Package className="h-4 w-4" />
    </div>
  );
}

function ShipmentLinesPane({
  lines,
  itemMap,
  onUpdate,
  onRemove,
}: {
  lines: LineRow[];
  itemMap: Map<string, ItemOption>;
  onUpdate: (idx: number, patch: Partial<LineRow>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="bg-card flex flex-col overflow-hidden rounded-md border">
      <div className="border-border border-b px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          On this shipment
          <span className="text-foreground/80 ml-1 normal-case tracking-normal">
            ({lines.length} {lines.length === 1 ? 'item' : 'items'})
          </span>
        </p>
      </div>
      {lines.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
          <Package className="h-5 w-5 opacity-60" />
          <p>Click items on the left to add them</p>
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">B.O.</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line, idx) => {
                const item = itemMap.get(line.itemId);
                return (
                  <tr key={`${line.itemId}-${idx}`}>
                    <td className="px-3 py-2">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {item?.sku ?? '—'}
                      </div>
                      <div className="truncate font-medium">
                        {item?.name ?? 'Unknown item'}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={line.qtyShipped}
                        onChange={(e) =>
                          onUpdate(idx, {
                            qtyShipped: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-20 text-right tabular-nums"
                        aria-label={`Qty shipped for ${item?.name ?? 'item'}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={line.qtyBackOrdered}
                        onChange={(e) =>
                          onUpdate(idx, {
                            qtyBackOrdered: Math.max(
                              0,
                              Number(e.target.value) || 0,
                            ),
                          })
                        }
                        className="w-20 text-right tabular-nums"
                        aria-label={`Back-ordered qty for ${item?.name ?? 'item'}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemove(idx)}
                        aria-label={`Remove ${item?.name ?? 'item'}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
