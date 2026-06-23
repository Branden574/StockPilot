'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
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
import { createPoAction } from '@/server/actions/purchase-orders';
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

interface PoFormProps {
  items: ItemOption[];
  suppliers: Option[];
  locations: Option[];
}

interface Line {
  itemId: string;
  quantityOrdered: number;
  unitCost: number;
}

export function PoForm({ items, suppliers, locations }: PoFormProps) {
  const router = useRouter();
  const [supplierId, setSupplierId] = React.useState<string>('');
  const [locationId, setLocationId] = React.useState<string>('');
  const [poNumber, setPoNumber] = React.useState<string>('');
  const [expectedAt, setExpectedAt] = React.useState<string>('');
  const [notes, setNotes] = React.useState<string>('');
  const [lines, setLines] = React.useState<Line[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  const total = lines.reduce((s, l) => s + l.quantityOrdered * l.unitCost, 0);

  function addLine() {
    setLines((prev) => [...prev, { itemId: '', quantityOrdered: 1, unitCost: 0 }]);
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
    if (lines.some((l) => !l.itemId || l.quantityOrdered <= 0)) {
      toast.error('Every line needs an item and a positive quantity.');
      return;
    }
    setSubmitting(true);
    const trimmedPoNumber = poNumber.trim();
    const res = await createPoAction({
      supplierId: supplierId || null,
      destinationLocationId: locationId || null,
      expectedAt: expectedAt ? new Date(expectedAt).toISOString() : null,
      notes: notes || undefined,
      // Only include poNumber when non-empty; omitting it lets the service
      // auto-generate via next_po_number().
      ...(trimmedPoNumber ? { poNumber: trimmedPoNumber } : {}),
      lines: lines.map((l) => ({ itemId: l.itemId, quantityOrdered: l.quantityOrdered, unitCost: l.unitCost })),
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Purchase order created.');
    router.push(`/dashboard/purchase-orders/${res.data.id}`);
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
                    <Select
                      value={line.itemId || '__pick'}
                      onValueChange={(v: string) => {
                        const picked = items.find((i) => i.id === v);
                        updateLine(idx, {
                          itemId: v,
                          unitCost: picked?.unit_cost ?? line.unitCost,
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Pick an item" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__pick" disabled>
                          Pick an item
                        </SelectItem>
                        {items.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name} — <span className="font-mono text-xs">{i.sku}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create PO'}
        </Button>
      </div>
    </div>
  );
}
