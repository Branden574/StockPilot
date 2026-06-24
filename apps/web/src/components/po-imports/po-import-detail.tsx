'use client';

import { Loader2, Plus, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ItemCombobox } from '@/components/inventory/item-combobox';
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
  charters: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string; warehouseId: string }>;
  items: Item[];
  /** AI-extracted expected delivery date (YYYY-MM-DD) prefilled into the picker. */
  defaultExpectedAt?: string | null;
}

export function PoImportDetail({
  header,
  lines,
  suppliers,
  warehouses,
  charters,
  locations,
  items,
  defaultExpectedAt,
}: Props) {
  const router = useRouter();
  const [vendorId, setVendorId] = React.useState<string>(header.vendor_id ?? '');
  const [warehouseId, setWarehouseId] = React.useState<string>(
    header.warehouse_id ?? '',
  );
  // Optional charter the imported items belong to (stock ownership), and an
  // optional specific destination location within the chosen warehouse.
  const [charterId, setCharterId] = React.useState<string>('');
  const [locationId, setLocationId] = React.useState<string>('');
  // Optional bill-to charter for the created PO — distinct from the item
  // charter above; this is the entity the PO is billed to (shown on the PDF).
  const [billToCharterId, setBillToCharterId] = React.useState<string>('');
  // Expected delivery date for the created PO, prefilled from the AI-extracted
  // ship/delivery date when present. `<input type="date">` value is YYYY-MM-DD.
  const [expectedAt, setExpectedAt] = React.useState<string>(defaultExpectedAt ?? '');
  // Whether newly-created items are products (default) or books. A "book PO"
  // creates item_type='book' so the lines land on the Books tab.
  const [createItemType, setCreateItemType] = React.useState<'product' | 'book'>('product');
  // Locations belong to a warehouse — only offer those in the chosen warehouse,
  // and clear the selection if the warehouse changes out from under it.
  const warehouseLocations = locations.filter((l) => l.warehouseId === warehouseId);
  React.useEffect(() => {
    if (locationId && !warehouseLocations.some((l) => l.id === locationId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- keep location valid for the warehouse
      setLocationId('');
    }
  }, [warehouseId, locationId, warehouseLocations]);
  const [overrides, setOverrides] = React.useState<
    Record<string, { itemId?: string | null; skip?: boolean }>
  >({});
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
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
      toast.success('Import re-parsed.');
      router.refresh();
    }
  }
  async function confirmCancel() {
    setBusy(true);
    const r = await cancelPoImportAction(header.id);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setCancelOpen(false);
    router.refresh();
  }
  function openCreateItems(lineIds: string[]) {
    if (!vendorId) {
      toast.error('Pick a vendor first. New items get tagged with it.');
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
      toast.error('Pick a vendor and a warehouse before approving.');
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
      locationId: locationId || null,
      charterId: billToCharterId || null,
      expectedAt: expectedAt ? new Date(expectedAt).toISOString() : null,
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
    toast.success('Import approved. Expected inbound PO created.');
    router.push(`/dashboard/purchase-orders/${r.data.poId}`);
  }

  const canApprove =
    header.status === 'parsed' || header.status === 'needs_review';

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memo intentional
  const preview = React.useMemo(
    () => buildPreview(lines, overrides, items),
    [lines, overrides, items],
  );

  const isScan = header.source_type === 'scan';
  const overallConf = header.extraction_confidence;
  const lowConfLineCount = lines.filter(
    (l) => l.extraction_confidence != null && l.extraction_confidence < 0.85,
  ).length;

  return (
    <div className="space-y-6">
      <div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm">
        <PoImportStatusBadge status={header.status} />
        <span className="text-muted-foreground">
          {header.source_type.toUpperCase()} ·{' '}
          {(header.file_size / 1024).toFixed(1)} KB
        </span>
        {isScan && overallConf != null && (
          <span
            className={
              'inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ' +
              (overallConf < 0.7
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : overallConf < 0.85
                  ? 'border-warning/40 bg-warning/10 text-warning'
                  : 'border-success/40 bg-success/10 text-success')
            }
            title={`Vision-model overall confidence: ${Math.round(overallConf * 100)}%`}
          >
            {Math.round(overallConf * 100)}% confidence
          </span>
        )}
        {header.parse_error && (
          <span className="text-destructive">{header.parse_error}</span>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={reparse} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Re-parse'}
          </Button>
          {header.status !== 'approved' && header.status !== 'canceled' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCancelOpen(true)}
              disabled={busy}
            >
              Cancel import
            </Button>
          )}
        </div>
      </div>

      <DestructiveConfirm
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this import?"
        description="The import is marked canceled — no items or stock movements will be created. The uploaded file is kept on the record for the audit trail."
        confirmLabel="Cancel import"
        cancelLabel="Keep import"
        pending={busy}
        onConfirm={confirmCancel}
      />

      {isScan && lowConfLineCount > 0 && (
        <div className="border-warning/40 bg-warning/5 text-foreground rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">
            {lowConfLineCount} line{lowConfLineCount === 1 ? '' : 's'} need a
            quick review
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            The vision model wasn't fully sure on those — they're highlighted
            yellow (low confidence) or red (very low). Skim them, fix any
            wrong character, then approve.
          </p>
        </div>
      )}

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
          <div>
            <label className="text-muted-foreground text-xs">Charter for items (optional)</label>
            <Select
              value={charterId || '__none'}
              onValueChange={(v) => setCharterId(v === '__none' ? '' : v)}
            >
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
          <div>
            <label className="text-muted-foreground text-xs">Bill to charter (optional)</label>
            <Select
              value={billToCharterId || '__none'}
              onValueChange={(v) => setBillToCharterId(v === '__none' ? '' : v)}
            >
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
          <div>
            <label className="text-muted-foreground text-xs">Create new items as</label>
            <Select
              value={createItemType}
              onValueChange={(v) => setCreateItemType(v === 'book' ? 'book' : 'product')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="product">Items</SelectItem>
                <SelectItem value="book">Books</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-muted-foreground text-xs">Location (optional)</label>
            <Select
              value={locationId || '__none'}
              onValueChange={(v) => setLocationId(v === '__none' ? '' : v)}
              disabled={!warehouseId}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={warehouseId ? 'Warehouse default' : 'Pick a warehouse first'}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Warehouse default</SelectItem>
                {warehouseLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-muted-foreground text-xs">Expected delivery (optional)</label>
            <Input
              type="date"
              value={expectedAt}
              onChange={(e) => setExpectedAt(e.target.value)}
            />
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

      <div className="overflow-x-auto rounded-xl border bg-card">
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
              // Extraction-confidence highlight (only meaningful for
              // source_type='scan'; deterministic-parsed CSV/PDF rows
              // have null confidence and render in the default tone).
              const conf = l.extraction_confidence;
              const confClass =
                conf == null
                  ? ''
                  : conf < 0.7
                    ? 'bg-destructive/5'
                    : conf < 0.85
                      ? 'bg-warning/5'
                      : '';
              return (
                <TableRow key={l.id} className={confClass}>
                  <TableCell className="tabular-nums">{l.line_number}</TableCell>
                  <TableCell className="max-w-[280px] truncate">
                    {l.description}
                    {conf != null && conf < 0.85 && (
                      <span
                        className={
                          'ml-2 inline-flex items-center rounded-full border px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide ' +
                          (conf < 0.7
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : 'border-warning/40 bg-warning/10 text-warning')
                        }
                        title={`Vision-model confidence: ${Math.round(conf * 100)}%`}
                      >
                        {Math.round(conf * 100)}%
                      </span>
                    )}
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
                      <div className="flex min-w-[220px] items-center gap-1.5">
                        <ItemCombobox
                          items={items.map((i) => ({
                            id: i.id,
                            sku: i.sku,
                            name: i.name,
                            detail:
                              i.quantityOnHand != null
                                ? `${i.quantityOnHand} on hand`
                                : null,
                          }))}
                          value={effectiveItemId ?? null}
                          onChange={(id) => setLineItem(l.id, id)}
                          className="min-w-[200px]"
                        />
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
        charterId={charterId || null}
        locationId={locationId || null}
        itemType={createItemType}
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
          toast.success(parts.length > 0 ? `${parts.join(' · ')}.` : 'Lines processed.');
          router.refresh();
        }}
      />
    </div>
  );
}
