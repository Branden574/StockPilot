'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { DetailSection } from '@/components/patterns/detail-section';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  deleteUomConversionAction,
  upsertUomConversionAction,
} from '@/server/actions/uom-conversions';

import type { RoundingRule } from '@stockpilot/core';

interface Conversion {
  id: string;
  item_id: string;
  from_uom: string;
  to_uom: string;
  numerator: number;
  denominator: number;
  rounding_rule: RoundingRule;
}

interface ItemOption {
  id: string;
  sku: string;
  name: string;
}

const COMMON_UOMS = ['EA', 'PK', 'BX', 'CT', 'DZ', 'KG', 'LB', 'L', 'GAL'];

export function UomConversionsManager({
  conversions,
  items,
}: {
  conversions: Conversion[];
  items: ItemOption[];
}) {
  const router = useRouter();
  const [itemId, setItemId] = React.useState('');
  const [fromUom, setFromUom] = React.useState('PK');
  const [toUom, setToUom] = React.useState('EA');
  const [numerator, setNumerator] = React.useState('24');
  const [denominator, setDenominator] = React.useState('1');
  const [rounding, setRounding] = React.useState<RoundingRule>('exact');
  const [busy, setBusy] = React.useState(false);
  const [deleteTargetId, setDeleteTargetId] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  // Why the last delete was refused, shown inside the confirm (a toast
  // alone sits behind the open dialog). Cleared on open and on each try.
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const itemMap = React.useMemo(
    () => new Map(items.map((i) => [i.id, `${i.sku} — ${i.name}`])),
    [items],
  );

  async function add() {
    if (!itemId) {
      toast.error('Pick an item to add a conversion for.');
      return;
    }
    const num = Number(numerator);
    const den = Number(denominator);
    if (!Number.isInteger(num) || num <= 0) {
      toast.error('Numerator must be a positive whole number.');
      return;
    }
    if (!Number.isInteger(den) || den <= 0) {
      toast.error('Denominator must be a positive whole number.');
      return;
    }
    setBusy(true);
    const r = await upsertUomConversionAction({
      itemId,
      fromUom: fromUom.toUpperCase(),
      toUom: toUom.toUpperCase(),
      numerator: num,
      denominator: den,
      roundingRule: rounding,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success(
      `Conversion saved: ${num}/${den} ${fromUom.toUpperCase()} → ${toUom.toUpperCase()}.`,
    );
    router.refresh();
  }
  function remove(id: string) {
    setDeleteError(null);
    setDeleteTargetId(id);
  }

  async function confirmDelete() {
    if (!deleteTargetId) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const r = await deleteUomConversionAction(deleteTargetId);
    setDeleteBusy(false);
    if (!r.ok) {
      setDeleteError(r.error.message);
      toast.error(r.error.message);
      return;
    }
    setDeleteTargetId(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <DetailSection title="Add conversion">
        <p className="text-muted-foreground -mt-1 mb-3 text-[12.5px]">
          Example: 1 PK of AA batteries equals 24 EA. Numerator=24, denominator=1.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="uom-item">Item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger id="uom-item">
                <SelectValue placeholder="Pick item" />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.sku} — {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uom-rounding">Rounding rule</Label>
            <Select value={rounding} onValueChange={(v) => setRounding(v as RoundingRule)}>
              <SelectTrigger id="uom-rounding">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="exact">Exact (allow fractions)</SelectItem>
                <SelectItem value="floor">Floor</SelectItem>
                <SelectItem value="ceil">Ceiling</SelectItem>
                <SelectItem value="round">Round</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uom-from">From UoM</Label>
            <Input
              id="uom-from"
              list="uom-suggestions"
              value={fromUom}
              onChange={(e) => setFromUom(e.target.value)}
              placeholder="PK"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uom-to">To UoM (base)</Label>
            <Input
              id="uom-to"
              list="uom-suggestions"
              value={toUom}
              onChange={(e) => setToUom(e.target.value)}
              placeholder="EA"
            />
          </div>
          <datalist id="uom-suggestions">
            {COMMON_UOMS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <div className="space-y-1.5">
            <Label htmlFor="uom-numerator">Numerator (e.g. 24 in &quot;1 PK = 24 EA&quot;)</Label>
            <Input
              id="uom-numerator"
              type="number"
              min="1"
              step="1"
              value={numerator}
              onChange={(e) => setNumerator(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uom-denominator">Denominator</Label>
            <Input
              id="uom-denominator"
              type="number"
              min="1"
              step="1"
              value={denominator}
              onChange={(e) => setDenominator(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={add} disabled={busy} variant="gradient" aria-busy={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Save conversion
          </Button>
        </div>
      </DetailSection>

      {/* Scrolls sideways inside its card on a narrow screen. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <Table className="min-w-[600px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead className="text-right">Ratio</TableHead>
              <TableHead>Rounding</TableHead>
              <TableHead className="w-12 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {conversions.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="text-muted-foreground py-6 text-center">
                  No conversions yet. Add one above.
                </TableCell>
              </TableRow>
            ) : (
              conversions.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{itemMap.get(c.item_id) ?? c.item_id}</TableCell>
                  <TableCell className="font-mono text-[12.5px]">{c.from_uom}</TableCell>
                  <TableCell className="font-mono text-[12.5px]">{c.to_uom}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {c.numerator}
                    {c.denominator !== 1 && ` / ${c.denominator}`}
                  </TableCell>
                  <TableCell className="text-ink-2">{c.rounding_rule}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(c.id)}
                      aria-label="Delete"
                    >
                      <Trash2 className="text-muted-foreground h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <DestructiveConfirm
        open={deleteTargetId !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTargetId(null);
        }}
        title="Delete this conversion?"
        description="Future receipts that rely on this conversion will fail until you re-add it. Past movements that used this conversion are unaffected."
        confirmLabel="Delete"
        pending={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
