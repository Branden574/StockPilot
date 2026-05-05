'use client';

import { Loader2, Plus, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { CreateItemsModal } from '@/components/po-imports/create-items-modal';
import { PoImportStatusBadge } from '@/components/po-imports/po-import-status-badge';
import {
  buildPreview,
  StockImpactPreview,
  type PreviewItem,
} from '@/components/po-imports/stock-impact-preview';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';

type Item = PreviewItem;

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
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createLines, setCreateLines] = React.useState<PoImportLineRow[]>([]);

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
  function openCreateItems(lineIds: string[]) {
    if (!vendorId) {
      toast.error('Pick a vendor first — new items get tagged with it');
      return;
    }
    const set = new Set(lineIds);
    const subset = lines.filter((l) => set.has(l.id));
    if (subset.length === 0) return;
    setCreateLines(subset);
    setCreateOpen(true);
  }

  function openConfirm() {
    if (!vendorId || !warehouseId) {
      toast.error('Pick a vendor and warehouse before approving');
      return;
    }
    if (preview.summary.unmappedCount > 0) {
      toast.error(
        `${preview.summary.unmappedCount} line(s) have no internal item — map or skip each one before approving.`,
      );
      return;
    }
    setConfirmOpen(true);
  }

  async function approve() {
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
    setConfirmOpen(false);
    toast.success('Import approved — expected inbound PO created');
    router.push(`/dashboard/purchase-orders/${r.data.poId}`);
  }

  const canApprove =
    header.status === 'parsed' || header.status === 'needs_review';

  const preview = React.useMemo(
    () => buildPreview(lines, overrides, items),
    [lines, overrides, items],
  );

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

      {(() => {
        const unmappedIds = lines
          .filter((l) => {
            const o = overrides[l.id] ?? {};
            const effectiveItemId = o.itemId !== undefined ? o.itemId : l.item_id;
            return l.line_type === 'inventory' && o.skip !== true && !effectiveItemId;
          })
          .map((l) => l.id);
        if (unmappedIds.length === 0 || !canApprove) return null;
        return (
          <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
            <Sparkles className="text-muted-foreground h-3.5 w-3.5" />
            <span>
              <strong>{unmappedIds.length}</strong> unmapped line
              {unmappedIds.length === 1 ? '' : 's'} — create new internal items
              from the PO so you don't have to enter them manually.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => openCreateItems(unmappedIds)}
              disabled={busy || !vendorId}
              title={!vendorId ? 'Pick a vendor first' : undefined}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Create {unmappedIds.length} as new items
            </Button>
          </div>
        );
      })()}

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
              const isUnmappedInventory =
                l.line_type === 'inventory' && o.skip !== true && !effectiveItemId;
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
                      <div className="flex items-center gap-1.5">
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
                        {isUnmappedInventory && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0 px-2 text-[11px]"
                            onClick={() => openCreateItems([l.id])}
                            disabled={busy || !vendorId}
                            title={
                              !vendorId
                                ? 'Pick a vendor first'
                                : 'Create a new internal item from this line'
                            }
                          >
                            <Plus className="h-3 w-3" /> Create
                          </Button>
                        )}
                      </div>
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
        <StockImpactPreview lines={lines} overrides={overrides} items={items} />
      )}

      {canApprove && (
        <div className="flex justify-end">
          <Button onClick={openConfirm} disabled={busy} variant="gradient">
            Review & approve
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve this import?</DialogTitle>
          </DialogHeader>
          <div className="text-muted-foreground space-y-2 text-sm">
            <p>
              An expected inbound PO will be created. Stock will{' '}
              <strong className="text-foreground">not</strong> change yet — the
              quantities below are added when you receive the PO.
            </p>
            <ul className="list-disc pl-5">
              <li>
                <strong className="text-foreground">
                  {preview.summary.mappedCount}
                </strong>{' '}
                item{preview.summary.mappedCount === 1 ? '' : 's'} will be
                receivable
              </li>
              <li>
                <strong className="text-foreground">
                  {preview.summary.totalUnits}
                </strong>{' '}
                total units inbound
              </li>
              {preview.summary.skippedCount > 0 && (
                <li>
                  {preview.summary.skippedCount} line
                  {preview.summary.skippedCount === 1 ? '' : 's'} skipped
                </li>
              )}
              {preview.summary.nonInventoryCount > 0 && (
                <li>
                  {preview.summary.nonInventoryCount} non-inventory line
                  {preview.summary.nonInventoryCount === 1 ? '' : 's'} ignored
                </li>
              )}
            </ul>
            <p className="text-[12px]">
              You can still receive partial quantities later — receiving is
              when the actual stock change posts.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Back to review
            </Button>
            <Button onClick={approve} disabled={busy} variant="gradient">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Approve & create PO'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateItemsModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        poImportId={header.id}
        vendorId={vendorId}
        warehouseId={warehouseId || null}
        lines={createLines}
        onSuccess={(counts) => {
          const parts: string[] = [];
          if (counts.created > 0)
            parts.push(`Created ${counts.created} item${counts.created === 1 ? '' : 's'}`);
          if (counts.linked > 0)
            parts.push(
              `Linked ${counts.linked} line${counts.linked === 1 ? '' : 's'} to existing items`,
            );
          if (counts.skipped > 0)
            parts.push(`Skipped ${counts.skipped}`);
          if (counts.mapped > 0)
            parts.push(
              `${counts.mapped} vendor mapping${counts.mapped === 1 ? '' : 's'}`,
            );
          toast.success(parts.length > 0 ? parts.join(' · ') : 'Done');
          router.refresh();
        }}
      />
    </div>
  );
}
