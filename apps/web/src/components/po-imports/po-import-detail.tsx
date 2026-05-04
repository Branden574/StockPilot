'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
  approvePoImportAction,
  cancelPoImportAction,
  parsePoImportAction,
} from '@/server/actions/po-imports';
import { PoImportStatusBadge } from '@/components/po-imports/po-import-status-badge';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';

interface Item {
  id: string;
  sku: string;
  name: string;
}

interface Props {
  header: PoImportRow;
  lines: PoImportLineRow[];
  suppliers: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
  items: Item[];
}

export function PoImportDetail({
  header,
  lines,
  suppliers,
  warehouses,
  items,
}: Props) {
  const router = useRouter();
  const [vendorId, setVendorId] = React.useState<string>(header.vendor_id ?? '');
  const [warehouseId, setWarehouseId] = React.useState<string>(
    header.warehouse_id ?? '',
  );
  const [overrides, setOverrides] = React.useState<
    Record<string, { itemId?: string | null; skip?: boolean }>
  >({});
  const [busy, setBusy] = React.useState(false);

  function setLineItem(lineId: string, itemId: string | null) {
    setOverrides((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), itemId } }));
  }
  function setLineSkip(lineId: string, skip: boolean) {
    setOverrides((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), skip } }));
  }

  async function reparse() {
    setBusy(true);
    const r = await parsePoImportAction(header.id);
    setBusy(false);
    if (!r.ok) toast.error(r.error.message);
    else {
      toast.success('Re-parsed');
      router.refresh();
    }
  }
  async function cancel() {
    if (!confirm('Cancel this import? It will not delete the uploaded file.'))
      return;
    setBusy(true);
    const r = await cancelPoImportAction(header.id);
    setBusy(false);
    if (!r.ok) toast.error(r.error.message);
    else router.refresh();
  }
  async function approve() {
    if (!vendorId || !warehouseId) {
      toast.error('Pick a vendor and warehouse before approving');
      return;
    }
    setBusy(true);
    const r = await approvePoImportAction({
      poImportId: header.id,
      warehouseId,
      vendorId,
      lineOverrides: Object.entries(overrides).map(([lineId, o]) => ({
        lineId,
        itemId: o.itemId ?? null,
        skip: o.skip === true,
      })),
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Import approved — expected inbound PO created');
    router.push(`/dashboard/purchase-orders/${r.data.poId}`);
  }

  const canApprove =
    header.status === 'parsed' || header.status === 'needs_review';

  return (
    <div className="space-y-6">
      <div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm">
        <PoImportStatusBadge status={header.status} />
        <span className="text-muted-foreground">
          {header.source_type.toUpperCase()} ·{' '}
          {(header.file_size / 1024).toFixed(1)} KB
        </span>
        {header.parse_error && (
          <span className="text-destructive">{header.parse_error}</span>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={reparse} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Re-parse'}
          </Button>
          {header.status !== 'approved' && header.status !== 'canceled' && (
            <Button variant="ghost" size="sm" onClick={cancel} disabled={busy}>
              Cancel import
            </Button>
          )}
        </div>
      </div>

      {canApprove && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-muted-foreground text-xs">Vendor</label>
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
          <div>
            <label className="text-muted-foreground text-xs">
              Destination warehouse
            </label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Vendor #</TableHead>
              <TableHead>Qty / UOM</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Internal item</TableHead>
              <TableHead className="w-20 text-right">Skip</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const o = overrides[l.id] ?? {};
              const effectiveItemId =
                o.itemId !== undefined ? o.itemId : l.item_id;
              return (
                <TableRow key={l.id}>
                  <TableCell className="tabular-nums">{l.line_number}</TableCell>
                  <TableCell className="max-w-[280px] truncate">
                    {l.description}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {l.vendor_item_number ?? '—'}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {l.qty_ordered_original} {l.uom_original}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {l.line_total != null ? `$${l.line_total.toFixed(2)}` : '—'}
                  </TableCell>
                  <TableCell>
                    <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide">
                      {l.line_type}
                    </span>
                  </TableCell>
                  <TableCell>
                    {l.line_type === 'inventory' ? (
                      <Select
                        value={effectiveItemId ?? ''}
                        onValueChange={(v) => setLineItem(l.id, v || null)}
                      >
                        <SelectTrigger className="h-8 text-xs">
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
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        non-inventory
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <input
                      type="checkbox"
                      checked={o.skip === true}
                      onChange={(e) => setLineSkip(l.id, e.target.checked)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {canApprove && (
        <div className="flex justify-end">
          <Button onClick={approve} disabled={busy} variant="gradient">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              'Approve & create expected inbound PO'
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
