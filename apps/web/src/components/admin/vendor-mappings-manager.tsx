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
  const [deleteTargetId, setDeleteTargetId] = React.useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  // Why the last delete was refused, shown inside the confirm (a toast
  // alone sits behind the open dialog). Cleared on open and on each try.
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  async function add() {
    if (!vendorId || !itemId || !vendorItemNumber.trim()) {
      toast.error('Vendor, item, and vendor item number are all required.');
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
    toast.success('Vendor mapping saved.');
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
    const r = await deleteVendorItemMappingAction(deleteTargetId);
    setDeleteBusy(false);
    if (!r.ok) {
      setDeleteError(r.error.message);
      toast.error(r.error.message);
      return;
    }
    setDeleteTargetId(null);
    router.refresh();
  }

  const vendorMap = new Map(suppliers.map((s) => [s.id, s.name]));
  const itemMap = new Map(items.map((i) => [i.id, `${i.sku} — ${i.name}`]));

  return (
    <div className="flex flex-col gap-4">
      <DetailSection title="Add mapping">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="vm-vendor">Vendor</Label>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger id="vm-vendor">
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
            <Label htmlFor="vm-item">Internal item</Label>
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger id="vm-item">
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
            <Label htmlFor="vm-number">Vendor item number</Label>
            <Input
              id="vm-number"
              placeholder="867474"
              value={vendorItemNumber}
              onChange={(e) => setVendorItemNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vm-description">
              Vendor description
              <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
            </Label>
            <Input
              id="vm-description"
              placeholder="Duracell Coppertop AA, 24/Pack"
              value={vendorDescription}
              onChange={(e) => setVendorDescription(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={add} disabled={busy} variant="gradient" aria-busy={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Save mapping
          </Button>
        </div>
      </DetailSection>

      {/* Scrolls sideways inside its card on a narrow screen. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <Table className="min-w-[560px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
                <TableCell className="font-mono text-[12.5px]">{m.vendor_item_number}</TableCell>
                <TableCell className="text-ink-2">{itemMap.get(m.item_id) ?? m.item_id}</TableCell>
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

      <DestructiveConfirm
        open={deleteTargetId !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTargetId(null);
        }}
        title="Delete this mapping?"
        description="Future PO imports from this vendor will no longer auto-link to the mapped item — operators will need to pick the item manually until you re-add it."
        confirmLabel="Delete"
        pending={deleteBusy}
        error={deleteError}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
