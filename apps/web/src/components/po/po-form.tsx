'use client';

import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { createPoAction, updatePoAction } from '@/server/actions/purchase-orders';
import { formatCurrency } from '@/lib/utils';

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  unit_cost: number;
}

interface Option {
  id: string;
  name: string;
}

export interface InitialPoValues {
  supplierId: string;
  locationId: string;
  /** Bill-to charter id ('' = none). */
  charterId: string;
  expectedAt: string;
  notes: string;
  poNumber: string;
  lines: Line[];
}

interface PoFormProps {
  items: ItemOption[];
  suppliers: Option[];
  locations: Option[];
  /** Bill-to charter options (rendered on the PO PDF). */
  charters: Option[];
  /** When set, the form is in edit mode for this PO id. */
  poId?: string;
  /** Pre-filled values for edit mode. */
  initial?: InitialPoValues;
}

/** A line is either an existing catalog item (itemId set) or a new item to create (newItemName set). */
interface Line {
  /** Set when the user picked an existing catalog item. */
  itemId?: string;
  /** Set when the user typed a free-text name for a new item to create. */
  newItemName?: string;
  quantityOrdered: number;
  unitCost: number;
}

/** Returns true when the line has a valid item selection. */
function lineHasItem(l: Line): boolean {
  return Boolean(l.itemId) || Boolean(l.newItemName?.trim());
}

// ─── ItemPicker ────────────────────────────────────────────────────────────
// A combobox that lets the user either pick an existing catalog item OR type a
// free-text name to create a new one.  Rendered inline inside each PO line row.

interface ItemPickerProps {
  items: ItemOption[];
  itemId: string | undefined;
  newItemName: string | undefined;
  onPickExisting: (item: ItemOption) => void;
  onPickNew: (name: string) => void;
}

function ItemPicker({ items, itemId, newItemName, onPickExisting, onPickNew }: ItemPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  // Derive the label shown in the trigger.
  const selectedItem = items.find((i) => i.id === itemId) ?? null;
  const triggerLabel = selectedItem
    ? `${selectedItem.sku} · ${selectedItem.name}`
    : newItemName
      ? `New: ${newItemName}`
      : null;

  // Items filtered by the current query.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Show "Create '<typed>'" only when there's a non-empty query that doesn't
  // exactly match an existing item name (case-insensitive).
  const trimmedQuery = query.trim();
  const showCreate =
    trimmedQuery.length > 0 &&
    trimmedQuery.length <= 200 &&
    !items.some((i) => i.name.toLowerCase() === trimmedQuery.toLowerCase());

  function handlePickExisting(item: ItemOption) {
    onPickExisting(item);
    setQuery('');
    setOpen(false);
  }

  function handlePickNew() {
    onPickNew(trimmedQuery);
    setQuery('');
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        className={cn(
          'border-border bg-background flex h-8 w-full items-center gap-2 rounded-md border px-2.5 text-left text-xs outline-none transition-colors',
          'hover:border-[var(--ed-line-strong)] focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className="flex-1 truncate">
          {triggerLabel ? (
            <span className={newItemName ? 'italic text-muted-foreground' : ''}>{triggerLabel}</span>
          ) : (
            <span className="text-muted-foreground">Pick or create an item…</span>
          )}
        </span>
        <ChevronsUpDown className="text-muted-foreground h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>

      <PopoverContent
        className="w-[min(480px,calc(100vw-1rem))] p-0"
        align="start"
        sideOffset={4}
      >
        <Command shouldFilter={false} className="bg-popover overflow-hidden rounded-md">
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <Search className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search by SKU or name, or type a new item name…"
              className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <Command.List className="max-h-[280px] overflow-y-auto p-1.5">
            {showCreate && (
              <Command.Item
                value={`__create__${trimmedQuery}`}
                onSelect={handlePickNew}
                className={ROW}
              >
                <Plus className="mr-2 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>
                  Create{' '}
                  <span className="font-medium">"{trimmedQuery}"</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">as a new item</span>
                </span>
              </Command.Item>
            )}
            {filtered.length === 0 && !showCreate && (
              <Command.Empty className="text-muted-foreground py-6 text-center text-sm">
                No matches. Type a name to create a new item.
              </Command.Empty>
            )}
            {filtered.map((i) => {
              const isActive = i.id === itemId;
              return (
                <Command.Item
                  key={i.id}
                  value={`${i.sku} ${i.name}`}
                  onSelect={() => handlePickExisting(i)}
                  className={ROW}
                >
                  {isActive ? (
                    <Check className="mr-2 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="mr-2 inline-block h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="text-muted-foreground mr-2 font-mono text-[11px]">{i.sku}</span>
                  <span className="flex-1 truncate">{i.name}</span>
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const ROW = cn(
  'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm outline-none',
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
);

// ─── PoForm ─────────────────────────────────────────────────────────────────

export function PoForm({ items, suppliers, locations, charters, poId, initial }: PoFormProps) {
  const router = useRouter();
  const [supplierId, setSupplierId] = React.useState<string>(initial?.supplierId ?? '');
  const [locationId, setLocationId] = React.useState<string>(initial?.locationId ?? '');
  const [charterId, setCharterId] = React.useState<string>(initial?.charterId ?? '');
  const [poNumber, setPoNumber] = React.useState<string>(initial?.poNumber ?? '');
  const [expectedAt, setExpectedAt] = React.useState<string>(initial?.expectedAt ?? '');
  const [notes, setNotes] = React.useState<string>(initial?.notes ?? '');
  const [lines, setLines] = React.useState<Line[]>(initial?.lines ?? []);
  const [submitting, setSubmitting] = React.useState(false);

  const total = lines.reduce((s, l) => s + l.quantityOrdered * l.unitCost, 0);

  function addLine() {
    setLines((prev) => [...prev, { quantityOrdered: 1, unitCost: 0 }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (lines.length === 0) {
      toast.error('Add at least one line item to the purchase order.');
      return;
    }
    if (lines.some((l) => !lineHasItem(l) || l.quantityOrdered <= 0)) {
      toast.error('Every line needs an item and a positive quantity.');
      return;
    }
    setSubmitting(true);
    const trimmedPoNumber = poNumber.trim();
    const payload = {
      supplierId: supplierId || null,
      destinationLocationId: locationId || null,
      charterId: charterId || null,
      expectedAt: expectedAt ? new Date(expectedAt).toISOString() : null,
      notes: notes || undefined,
      // Only include poNumber when non-empty; omitting it lets the service
      // auto-generate via next_po_number().
      ...(trimmedPoNumber ? { poNumber: trimmedPoNumber } : {}),
      lines: lines.map((l) =>
        l.itemId
          ? { itemId: l.itemId, quantityOrdered: l.quantityOrdered, unitCost: l.unitCost }
          : { newItemName: l.newItemName!.trim(), quantityOrdered: l.quantityOrdered, unitCost: l.unitCost },
      ),
    };

    if (poId) {
      // Edit mode
      const res = await updatePoAction(poId, payload);
      setSubmitting(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Purchase order updated.');
      router.push(`/dashboard/purchase-orders/${poId}`);
    } else {
      // Create mode
      const res = await createPoAction(payload);
      setSubmitting(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      toast.success('Purchase order created.');
      router.push(`/dashboard/purchase-orders/${res.data.id}`);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>
            Supplier
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select value={supplierId || '__none'} onValueChange={(v: string) => setSupplierId(v === '__none' ? '' : v)}>
            <SelectTrigger>
              <SelectValue placeholder="No supplier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">No supplier</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>
            Destination location
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select value={locationId || '__none'} onValueChange={(v: string) => setLocationId(v === '__none' ? '' : v)}>
            <SelectTrigger>
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">None</SelectItem>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>
            PO number
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            placeholder="Auto-generated if left blank"
            maxLength={64}
          />
        </div>
        <div className="space-y-1.5">
          <Label>
            Expected delivery
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label>
            Bill to charter
            <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Select value={charterId || '__none'} onValueChange={(v: string) => setCharterId(v === '__none' ? '' : v)}>
            <SelectTrigger>
              <SelectValue placeholder="No charter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">No charter</SelectItem>
              {charters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Line items</Label>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
        </div>
        {lines.length === 0 ? (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            No lines yet. Click "Add line" to start.
          </div>
        ) : (
          <div className="space-y-2">
            {lines.map((line, idx) => {
              return (
                <div key={idx} className="grid grid-cols-12 gap-2 rounded-md border bg-card p-3">
                  <div className="col-span-5 space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Item</Label>
                    <ItemPicker
                      items={items}
                      itemId={line.itemId}
                      newItemName={line.newItemName}
                      onPickExisting={(item) =>
                        updateLine(idx, {
                          itemId: item.id,
                          newItemName: undefined,
                          unitCost: item.unit_cost,
                        })
                      }
                      onPickNew={(name) =>
                        updateLine(idx, {
                          itemId: undefined,
                          newItemName: name,
                        })
                      }
                    />
                    {line.newItemName && (
                      <p className="text-[10px] text-muted-foreground">
                        A new catalog item will be created when you save this PO.
                      </p>
                    )}
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Qty</Label>
                    <BlankZeroNumberInput
                      min={1}
                      step={1}
                      value={line.quantityOrdered}
                      onValueChange={(n) => updateLine(idx, { quantityOrdered: n })}
                      placeholder="Qty"
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Unit cost</Label>
                    <BlankZeroNumberInput
                      min={0}
                      step={0.01}
                      value={line.unitCost}
                      onValueChange={(n) => updateLine(idx, { unitCost: n })}
                      placeholder="0.00"
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Subtotal</Label>
                    <p className="px-2 py-2 text-sm tabular-nums">
                      {formatCurrency(line.quantityOrdered * line.unitCost)}
                    </p>
                  </div>
                  <div className="col-span-1 flex items-end">
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeLine(idx)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="flex justify-end pt-2 text-sm">
              <span className="text-muted-foreground">Total: </span>
              <span className="ml-2 font-semibold tabular-nums">{formatCurrency(total)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>
          Notes
          <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="gradient" onClick={submit} disabled={submitting || lines.length === 0}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : poId ? 'Save changes' : 'Create PO'}
        </Button>
      </div>
    </div>
  );
}
