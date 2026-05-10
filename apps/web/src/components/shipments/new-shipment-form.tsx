'use client';

import { Command } from 'cmdk';
import { Loader2, Search, Trash2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
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
  destinationWarehouses,
  items,
}: {
  sourceWarehouses: WarehouseOption[];
  destinationWarehouses: WarehouseOption[];
  items: ItemOption[];
}) {
  const router = useRouter();
  const [sourceWarehouseId, setSourceWarehouseId] = React.useState<string>(
    () => sourceWarehouses[0]?.id ?? '',
  );
  // Default destination: first warehouse that isn't the source.
  const [destinationWarehouseId, setDestinationWarehouseId] =
    React.useState<string>(() => {
      const first = destinationWarehouses.find(
        (w) => w.id !== (sourceWarehouses[0]?.id ?? ''),
      );
      return first?.id ?? '';
    });
  const [lines, setLines] = React.useState<LineRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { attentionToName: '', notes: '', ccEmails: '' },
  });

  // Index items by id for quick lookup in the row table.
  const itemMap = React.useMemo(() => {
    const m = new Map<string, ItemOption>();
    for (const i of items) m.set(i.id, i);
    return m;
  }, [items]);

  // Destinations = all active warehouses except the currently-selected
  // source. We mirror this client-side so the user never picks a self-
  // shipment by mistake; the server schema accepts any UUID, so this is
  // purely UX sugar.
  const filteredDestinations = React.useMemo(
    () => destinationWarehouses.filter((w) => w.id !== sourceWarehouseId),
    [destinationWarehouses, sourceWarehouseId],
  );

  // If the user picks a source that matches the current destination,
  // clear the destination so they re-pick.
  React.useEffect(() => {
    if (
      destinationWarehouseId &&
      destinationWarehouseId === sourceWarehouseId
    ) {
      const next = destinationWarehouses.find((w) => w.id !== sourceWarehouseId);
      setDestinationWarehouseId(next?.id ?? '');
    }
  }, [sourceWarehouseId, destinationWarehouseId, destinationWarehouses]);

  function addItem(itemId: string) {
    setLines((prev) => {
      // If the item is already in the list, just bump its qty by 1
      // instead of adding a duplicate row.
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
    if (!destinationWarehouseId) {
      toast.error('Pick a destination warehouse');
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
      destinationWarehouseId,
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
    !!sourceWarehouseId && !!destinationWarehouseId && lines.length > 0;

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
          <Label htmlFor="dest-wh">Destination warehouse</Label>
          <Select
            value={destinationWarehouseId}
            onValueChange={setDestinationWarehouseId}
          >
            <SelectTrigger id="dest-wh">
              <SelectValue placeholder="Pick a destination warehouse" />
            </SelectTrigger>
            <SelectContent>
              {filteredDestinations.length === 0 && (
                <SelectItem value="__none" disabled>
                  No other active warehouses
                </SelectItem>
              )}
              {filteredDestinations.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}{' '}
                  <span className="text-muted-foreground text-xs">({w.code})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        <div className="flex items-center justify-between">
          <Label>Line items</Label>
          <p className="text-muted-foreground text-xs">
            {lines.length === 0
              ? 'Pick items below to add them'
              : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
          </p>
        </div>

        <ItemPicker items={items} onPick={addItem} />

        {lines.length > 0 && (
          <div className="overflow-hidden rounded-md border">
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
                            updateLine(idx, {
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
                            updateLine(idx, {
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
                          onClick={() => removeLine(idx)}
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
 * Inline cmdk-powered combobox over the pre-loaded item list. We don't
 * use the dialog form (that's the global ⌘K palette pattern); this lives
 * inside the form and adds a row to the line table on Enter / click.
 *
 * Why not RHF here: the line list is local state with non-trivial
 * mutations (qty/B.O. edits, dedupe by itemId). useFieldArray would force
 * us to keep two parallel sources of truth.
 */
function ItemPicker({
  items,
  onPick,
}: {
  items: ItemOption[];
  onPick: (itemId: string) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Close the dropdown when the user clicks outside.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Top 50 matches — covers UI sweet spot without rendering 200 rows.
  const trimmed = query.trim().toLowerCase();
  const matches = React.useMemo(() => {
    if (trimmed.length === 0) return items.slice(0, 8);
    return items
      .filter((i) => {
        const hay = `${i.name} ${i.sku} ${i.barcode ?? ''}`.toLowerCase();
        return hay.includes(trimmed);
      })
      .slice(0, 50);
  }, [items, trimmed]);

  function handlePick(id: string) {
    onPick(id);
    setQuery('');
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <Command
        // Disable cmdk's built-in fuzzy filter — we run our own matcher above.
        shouldFilter={false}
        className="bg-card overflow-visible rounded-md border"
      >
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground h-4 w-4" />
          <Command.Input
            value={query}
            onValueChange={(v) => {
              setQuery(v);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="Pick an item by name, SKU, or barcode…"
            className="placeholder:text-muted-foreground flex h-10 w-full bg-transparent text-sm outline-none"
          />
        </div>
        {open && (
          <Command.List className="max-h-60 overflow-y-auto p-1">
            {matches.length === 0 && (
              <Command.Empty className="text-muted-foreground py-4 text-center text-xs">
                No matches.
              </Command.Empty>
            )}
            {matches.map((i) => (
              <Command.Item
                key={i.id}
                value={`${i.name} ${i.sku} ${i.barcode ?? ''}`}
                onSelect={() => handlePick(i.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
                  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
                )}
              >
                <span className="flex-1 truncate">{i.name}</span>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {i.sku}
                </span>
                <span className="text-muted-foreground tabular-nums text-[11px]">
                  {i.quantityOnHand}
                </span>
              </Command.Item>
            ))}
          </Command.List>
        )}
      </Command>
    </div>
  );
}
