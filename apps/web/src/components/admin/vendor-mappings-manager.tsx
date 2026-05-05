'use client';

import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  deleteVendorItemMappingAction,
  upsertVendorItemMappingAction,
} from '@/server/actions/vendor-item-mappings';

interface Mapping {
  id: string;
  vendor_id: string;
  item_id: string;
  vendor_item_number: string | null;
  vendor_product_number: string | null;
  auxiliary_number: string | null;
  vendor_description: string | null;
}

export function VendorMappingsManager({
  mappings,
  suppliers,
  items,
}: {
  mappings: Mapping[];
  suppliers: Array<{ id: string; name: string }>;
  items: Array<{ id: string; sku: string; name: string }>;
}) {
  const router = useRouter();
  const [vendorId, setVendorId] = React.useState('');
  const [itemId, setItemId] = React.useState('');
  const [vendorItemNumber, setVendorItemNumber] = React.useState('');
  const [vendorDescription, setVendorDescription] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function add() {
    if (!vendorId || !itemId || !vendorItemNumber.trim()) {
      toast.error('Vendor, item, and vendor item number are required');
      return;
    }
    setBusy(true);
    const r = await upsertVendorItemMappingAction({
      vendorId,
      itemId,
      vendorItemNumber: vendorItemNumber.trim(),
      vendorDescription: vendorDescription.trim() || null,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setVendorItemNumber('');
    setVendorDescription('');
    toast.success('Mapping saved');
    router.refresh();
  }
  async function remove(id: string) {
    if (!confirm('Delete this mapping?')) return;
    const r = await deleteVendorItemMappingAction(id);
    if (!r.ok) toast.error(r.error.message);
    else router.refresh();
  }

  const vendorMap = new Map(suppliers.map((s) => [s.id, s.name]));
  const itemMap = new Map(items.map((i) => [i.id, `${i.sku} — ${i.name}`]));

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Add mapping</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick vendor" />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Internal item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger>
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
            <Label>Vendor item number</Label>
            <Input
              placeholder="867474"
              value={vendorItemNumber}
              onChange={(e) => setVendorItemNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Vendor description (optional)</Label>
            <Input
              placeholder="Duracell Coppertop AA, 24/Pack"
              value={vendorDescription}
              onChange={(e) => setVendorDescription(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={add} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Vendor item #</TableHead>
              <TableHead>Internal item</TableHead>
              <TableHead className="w-16 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {mappings.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{vendorMap.get(m.vendor_id) ?? m.vendor_id}</TableCell>
                <TableCell className="font-mono text-xs">
                  {m.vendor_item_number}
                </TableCell>
                <TableCell>{itemMap.get(m.item_id) ?? m.item_id}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(m.id)}
                    aria-label="Delete"
                  >
                    <Trash2 className="text-muted-foreground h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
