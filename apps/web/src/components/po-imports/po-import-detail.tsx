'use client';

import { Download, Loader2, Plus, Sparkles } from 'lucide-react';
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

import { MappingConfirmation } from '@/components/po-imports/mapping-confirmation';

import { dedupeItemsBySku } from '@/lib/po-imports/dedupe-items';

import {
  BLOCKING_LINE_RESULTS,
  LINE_RESULT_LABELS,
  type LineResult,
} from '@stockpilot/core';

import type { PoImportLineRow, PoImportRow } from '@/server/services/po-imports';
import type { LineResolution } from '@/server/services/po-imports-variants';
import { HelpTip } from '@/components/onboarding/help-tip';

// createdAt drives the match dropdown's SKU-dedupe (oldest row wins); the
// preview only needs the PreviewItem fields and ignores the extra key.
type Item = PreviewItem & { createdAt: string };

// suggested_item_id (Tasks 2/3) is advisory-only and ALREADY on
// PoImportLineRow; suggestionLabel is a UI-only human-readable string
// page.tsx resolves from the items lookup it already loads. Optional so
// existing callers/tests that pass plain PoImportLineRow[] keep compiling.
export type LineWithSuggestion = PoImportLineRow & {
  suggestionLabel?: string | null;
};

interface Props {
  header: PoImportRow;
  lines: LineWithSuggestion[];
  suppliers: Array<{ id: string; name: string }>;
  warehouses: Array<{ id: string; name: string }>;
  charters: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string; warehouseId: string }>;
  items: Item[];
  /** AI-extracted expected delivery date (YYYY-MM-DD) prefilled into the picker. */
  defaultExpectedAt?: string | null;
  /**
   * Server-resolved review verdict per line id (Task 14). Optional so the
   * component still renders for callers that predate it — an absent entry
   * reads as 'ready', which is exactly what every non-sports line resolves to.
   */
  resolutions?: Record<string, LineResolution>;
  /**
   * Categories the new items may be filed under. The category is what decides
   * the tracking profile — and therefore whether a line becomes a sports
   * group/variant at all — so it is chosen in the create-items modal, never
   * inferred.
   */
  categories?: Array<{ id: string; name: string; sportsSubcategoryKey: string | null }>;
}

/**
 * Sentinel values for the "Charter for items" select. Radix Select forbids an
 * empty-string item value, so the two non-uuid choices need real sentinels.
 * They are DISTINCT on purpose: KEEP means "I am not stating an ownership
 * charter, change nothing", GENERIC means "I am stating one, and it is no
 * charter". Collapsing them back into one value is how the original defect
 * turned a blank field into a destructive re-charter.
 */
const CHARTER_KEEP = '__keep';
const CHARTER_GENERIC = '__none';

/**
 * Human-readable variant attributes for the review table's Variant cell.
 *
 * Reads the LINE's own columns, not the resolution: what the document said is
 * what a reviewer needs to see, whether or not it matched anything. The
 * uniform number is labelled "#", never "Serial" — the requirements forbid
 * that field ever being presented as a serial.
 */
function variantLabel(l: PoImportLineRow): string {
  const parts = [
    l.jersey_number ? `#${l.jersey_number}` : null,
    l.variant_size
      ? [l.variant_size, l.variant_size_system].filter(Boolean).join(' ')
      : null,
    l.variant_width,
    l.variant_fit,
    l.variant_color,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length > 0 ? parts.join(' · ') : '—';
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
  resolutions,
  categories,
}: Props) {
  const router = useRouter();
  const [vendorId, setVendorId] = React.useState<string>(header.vendor_id ?? '');
  // Owner directive: choosing the destination warehouse must be an EXPLICIT
  // act — never seeded from header.warehouse_id. (The old seed was also a
  // stale-id hazard: options only list ACTIVE warehouses, so a stale id
  // rendered as an empty placeholder while state silently held it.)
  const [warehouseId, setWarehouseId] = React.useState<string>('');
  // Inline field errors shown when "Review & approve" is attempted with a
  // missing selection (repo pattern #20: inline alert, toast is supplemental).
  // Each error clears as soon as the field is picked.
  const [approveErrors, setApproveErrors] = React.useState<{
    vendor?: string;
    warehouse?: string;
    location?: string;
  }>({});
  // Optional charter the imported items belong to (stock ownership), and the
  // REQUIRED destination location within the chosen warehouse (approve is
  // blocked until one is picked — the server no longer auto-resolves one).
  // Tri-state, encoded in one string so the Select stays a plain controlled
  // input: '' = KEEP (express no ownership intent — approve() leaves every
  // item's charter alone), CHARTER_GENERIC = explicitly move ownership to
  // Generic, any uuid = explicitly move ownership to that charter. KEEP is the
  // default because the harmful path must be the one you have to choose.
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
    Record<string, { itemId?: string | null; skip?: boolean; mode?: 'use_existing' }>
  >({});
  const [busy, setBusy] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createLines, setCreateLines] = React.useState<PoImportLineRow[]>([]);

  // The org's data model allows the same SKU across multiple rows (per-rack
  // row model / "duplicate to rack"), which made the match dropdown list
  // "Into Algebra 1 (SP-…)" once per rack. Collapse the OPTIONS to one per
  // SKU — targeting the OLDEST row — for the combobox ONLY. Every id-based
  // lookup (stock preview, pre-matched lines) still uses the FULL `items`.
  const dedupedOptions = React.useMemo(
    () => dedupeItemsBySku(items).map((i) => ({ id: i.id, sku: i.sku, name: i.name })),
    [items],
  );
  const dedupedOptionIds = React.useMemo(
    () => new Set(dedupedOptions.map((o) => o.id)),
    [dedupedOptions],
  );
  const itemsById = React.useMemo(
    () => new Map(items.map((i) => [i.id, i])),
    [items],
  );
  // Model B: the org's data model allows the same SKU across multiple
  // inventory_items rows — one per charter/rack "placement" (see
  // lib/inventory/group-by-sku.ts). A line's matched/created item is only
  // ONE placement, which can be a small slice of a much bigger SKU total
  // (e.g. the matched placement holds 100 while the SKU totals 281 across
  // placements) — showing only "100 → 200" reads as wrong to the owner.
  // Computed here from the SAME full `items` list already loaded via
  // listForMatching (no extra DB query) and threaded into buildPreview /
  // StockImpactPreview as a pure, read-time, display-only projection.
  const skuTotalBySku = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) {
      if (!i.sku) continue;
      m.set(i.sku, (m.get(i.sku) ?? 0) + (i.quantityOnHand || 0));
    }
    return m;
  }, [items]);
  // ItemCombobox resolves its trigger label from its OWN items prop — a line
  // already matched to a NON-oldest duplicate row must have that row appended
  // to the options, or the trigger would fall back to the placeholder.
  function comboOptionsFor(selectedId: string | null) {
    if (!selectedId || dedupedOptionIds.has(selectedId)) return dedupedOptions;
    const selected = itemsById.get(selectedId);
    if (!selected) return dedupedOptions;
    return [...dedupedOptions, { id: selected.id, sku: selected.sku, name: selected.name }];
  }

  function setLineItem(lineId: string, itemId: string | null) {
    setOverrides((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), itemId } }));
  }
  function setLineSkip(lineId: string, skip: boolean) {
    setOverrides((m) => ({ ...m, [lineId]: { ...(m[lineId] ?? {}), skip } }));
  }
  // Matching is ADVISORY ONLY (Tasks 2/3): a line with a suggested_item_id
  // still defaults to create-new until a human explicitly accepts it. This
  // is the accept action — it links the line to the suggested item (same
  // effect as picking it in the combobox) AND stamps mode: 'use_existing'
  // so the decision reads the same as an explicit manual link, never an
  // auto-selected default.
  function acceptSuggestion(lineId: string, suggestedItemId: string) {
    setOverrides((m) => ({
      ...m,
      [lineId]: { ...(m[lineId] ?? {}), itemId: suggestedItemId, mode: 'use_existing' },
    }));
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
    // An unresolved LINE is checked before the shipment fields: a line whose
    // identity is ambiguous cannot be imported at any warehouse, so telling
    // the user to pick a location first would be busywork ahead of the real
    // blocker. Requirements: "ambiguous -> review, never auto-merge".
    if (blockedLines.length > 0) {
      toast.error(
        `${blockedLines.length} line(s) need a decision first — see the Result column. Nothing is merged automatically.`,
      );
      return;
    }
    // Inline field validation (pattern #20). The location is REQUIRED: when
    // the chosen warehouse has sites, one must be picked; when it has none,
    // approve stays blocked until a site is added — no silent fallback.
    const errors: typeof approveErrors = {};
    if (!vendorId) errors.vendor = 'Pick a vendor before approving.';
    if (!warehouseId) {
      errors.warehouse = 'Pick a destination warehouse before approving.';
    } else if (warehouseLocations.length === 0) {
      errors.location =
        'This warehouse has no sites to receive into — add one under Locations before approving.';
    } else if (!locationId) {
      errors.location = 'Pick a destination location before approving.';
    }
    if (errors.vendor || errors.warehouse || errors.location) {
      setApproveErrors(errors);
      toast.error('Fix the highlighted fields before approving.');
      return;
    }
    setApproveErrors({});
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
    // A THROWN action (network 500, or a stale bundle after a fresh deploy —
    // the server-action id no longer resolves) must not leave the button
    // spinning forever with no feedback: try/finally guarantees the spinner
    // resets and the user sees a clear, actionable message.
    try {
      const r = await approvePoImportAction({
        poImportId: header.id,
        warehouseId,
        vendorId,
        // Guaranteed non-empty: openConfirm blocks approve without a location.
        locationId,
        // BILLING. Goes to purchase_orders.charter_id and nowhere else.
        charterId: billToCharterId || null,
        // OPERATIONAL. Omitted entirely when the user left the ownership select
        // on "Keep" — the server then touches no item's charter. Never derived
        // from billToCharterId (owner rule B3: no silent fallback).
        ...(charterId === ''
          ? {}
          : { itemCharterId: charterId === CHARTER_GENERIC ? null : charterId }),
        expectedAt: expectedAt ? new Date(expectedAt).toISOString() : null,
        lineOverrides: Object.entries(overrides).map(([lineId, o]) => ({
          lineId,
          itemId: o.itemId ?? null,
          skip: o.skip === true,
        })),
      });
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setConfirmOpen(false);
      toast.success('Import approved. Expected inbound PO created.');
      router.push(`/dashboard/purchase-orders/${r.data.poId}`);
    } catch {
      toast.error(
        'Could not reach the server to approve this import. If StockPilot just updated (see the reload prompt), reload the page and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const canApprove =
    header.status === 'parsed' || header.status === 'needs_review';

  // Lines whose verdict is an OPEN QUESTION — an ambiguous match, a possible
  // duplicate, a missing required attribute, a serial mismatch, or an
  // unconfirmed column mapping. Requirements: "ambiguous -> review, never
  // auto-merge"; approval stays blocked until each one is resolved. A skipped
  // line is not imported, so it cannot block.
  const blockedLines = lines.filter((l) => {
    if (overrides[l.id]?.skip === true) return false;
    const r = resolutions?.[l.id]?.result;
    return r != null && BLOCKING_LINE_RESULTS.has(r);
  });

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memo intentional
  const preview = React.useMemo(
    () => buildPreview(lines, overrides, items, skuTotalBySku),
    [lines, overrides, items, skuTotalBySku],
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
          {/* Recordkeeping export: downloads EVERY line (inventory + tax /
              freight / service / fee / discount) plus the header money totals
              for manual/paper audit. Distinct read path from PO creation. */}
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/po-imports/${header.id}/export.csv`}
              download
              aria-label="Download this PO import as CSV"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </a>
          </Button>
          {header.status !== 'approved' && header.status !== 'canceled' && (
            <Button variant="outline" size="sm" onClick={reparse} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Re-parse'}
            </Button>
          )}
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
        // B5: billing and operational placement live in two visibly separate
        // sections. Both stay fully visible and editable — the fix for the
        // bill-to/ownership conflation is separation, never concealment.
        <div className="space-y-4">
        <section className="border-border rounded-md border p-3">
          <h3 className="text-foreground text-sm font-medium">Operational placement</h3>
          <p className="text-muted-foreground mt-0.5 mb-3 text-xs">
            Where this PO receives and who owns the stock. Nothing in the Billing
            section below affects any of it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-muted-foreground text-xs">Vendor</label>
            <Select
              value={vendorId}
              onValueChange={(v) => {
                setVendorId(v);
                setApproveErrors((e) => ({ ...e, vendor: undefined }));
              }}
            >
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
            {approveErrors.vendor && (
              <p role="alert" className="text-destructive mt-1 text-xs">
                {approveErrors.vendor}
              </p>
            )}
          </div>
          <div>
            <label className="text-muted-foreground text-xs">
              Destination warehouse
            </label>
            <Select
              value={warehouseId}
              onValueChange={(v) => {
                setWarehouseId(v);
                // The location list changes with the warehouse — clear its
                // error too; a stale message would point at the old list.
                setApproveErrors((e) => ({
                  ...e,
                  warehouse: undefined,
                  location: undefined,
                }));
              }}
            >
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
            {approveErrors.warehouse && (
              <p role="alert" className="text-destructive mt-1 text-xs">
                {approveErrors.warehouse}
              </p>
            )}
          </div>
          <div>
            <label className="text-muted-foreground text-xs inline-flex items-center gap-1">
              Charter for items (ownership)
              <HelpTip label="Charter for items">
                <p>
                  Sets who <strong>owns</strong> the stock: items created from these
                  lines are stamped with this charter, and at approval every line is
                  pointed at the instance owned by it. Independent of billing — a PO
                  billed to one charter can stock items owned by another.
                </p>
                <p className="mt-1">
                  Leave it on &ldquo;Keep each item&apos;s current charter&rdquo; to
                  change no ownership at all.
                </p>
              </HelpTip>
            </label>
            <Select
              value={charterId || CHARTER_KEEP}
              onValueChange={(v) => setCharterId(v === CHARTER_KEEP ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Keep each item's current charter" />
              </SelectTrigger>
              <SelectContent>
                {/* Default = express NO ownership intent. approve() then leaves
                    every item's charter exactly as it is. "No charter" below is
                    a DIFFERENT, explicit choice: move ownership to Generic. */}
                <SelectItem value={CHARTER_KEEP}>
                  Keep each item&apos;s current charter
                </SelectItem>
                <SelectItem value={CHARTER_GENERIC}>No charter (Generic)</SelectItem>
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
            <label className="text-muted-foreground text-xs">Destination location</label>
            {warehouseId && warehouseLocations.length === 0 ? (
              // No silent fallback: the old "Warehouse default" option let the
              // server auto-create a synthetic location. Surface the gap and
              // block approve until a real site exists.
              <p className="border-warning/40 bg-warning/5 text-foreground rounded-md border px-3 py-2 text-xs">
                No sites are linked to this warehouse yet — add one under
                Locations first
              </p>
            ) : (
              <Select
                value={locationId}
                onValueChange={(v) => {
                  setLocationId(v);
                  setApproveErrors((e) => ({ ...e, location: undefined }));
                }}
                disabled={!warehouseId}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={warehouseId ? 'Pick a location' : 'Pick a warehouse first'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {warehouseLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {approveErrors.location && (
              <p role="alert" className="text-destructive mt-1 text-xs">
                {approveErrors.location}
              </p>
            )}
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
        </section>

        <section className="border-border rounded-md border p-3">
          <h3 className="text-foreground text-sm font-medium">
            Billing — does not affect placement
          </h3>
          <p className="text-muted-foreground mt-0.5 mb-3 text-xs">
            Financial metadata only. It is printed on the purchase-order
            document&apos;s &ldquo;Bill to&rdquo; block and changes nothing else:
            not the receiving warehouse, not the destination location, not who
            owns the stock, not which list this PO appears in, not who can see it.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-muted-foreground text-xs inline-flex items-center gap-1">
              Bill to charter (optional)
              <HelpTip label="Bill to charter">
                <p>
                  Sets who is <strong>billed</strong> on the purchase-order document
                  itself. It does not affect who owns the items — that is
                  &ldquo;Charter for items&rdquo; under Operational placement.
                </p>
              </HelpTip>
            </label>
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
          </div>
        </section>
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

      <MappingConfirmation
        poImportId={header.id}
        lines={lines}
        editable={canApprove}
        onConfirmed={() => router.refresh()}
      />

      {blockedLines.length > 0 && canApprove && (
        <div className="border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2 text-xs">
          <strong>{blockedLines.length}</strong>{' '}
          {`${
            blockedLines.length === 1 ? 'line needs' : 'lines need'
          } a decision before this import can be approved — see the Result column. Nothing is merged or linked automatically.`}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Vendor #</TableHead>
              <TableHead>Group</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Qty / UOM</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Result</TableHead>
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
              // Advisory chip (Tasks 2/3): a match was found (barcode/ISBN/
              // vendor mapping) but never auto-linked. Only surface it while
              // the line is still unresolved — the default stays create-new
              // until the user explicitly accepts it below.
              const hasSuggestion = isUnmappedInventory && Boolean(l.suggested_item_id);
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
              // Task 14 verdict. Absent = a caller that predates the resolver;
              // 'ready' is what every non-sports line resolves to anyway.
              const resolution = resolutions?.[l.id];
              const result: LineResult = resolution?.result ?? 'ready';
              const isBlocked = o.skip !== true && BLOCKING_LINE_RESULTS.has(result);
              return (
                <TableRow
                  key={l.id}
                  className={isBlocked ? 'bg-destructive/5' : confClass}
                >
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
                  <TableCell className="max-w-[180px] truncate text-xs">
                    {resolution?.groupName ??
                      (resolution && resolution.groupCandidates.length > 0
                        ? `${resolution.groupCandidates.length} candidate${
                            resolution.groupCandidates.length === 1 ? '' : 's'
                          }`
                        : (l.group_hint ?? '—'))}
                  </TableCell>
                  <TableCell className="text-xs">{variantLabel(l)}</TableCell>
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
                  <TableCell className="max-w-[200px]">
                    {/* Never a bare Valid/Invalid — the cell says what will
                        happen, or what question is still open. */}
                    <span
                      className={
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ' +
                        (isBlocked
                          ? 'border-destructive/40 bg-destructive/10 text-destructive'
                          : 'border-border text-muted-foreground')
                      }
                      title={resolution?.message ?? undefined}
                    >
                      {LINE_RESULT_LABELS[result]}
                    </span>
                    {isBlocked && resolution?.message && (
                      <p className="text-muted-foreground mt-1 text-[10.5px] leading-snug">
                        {resolution.message}
                      </p>
                    )}
                    {isBlocked && resolution && resolution.groupCandidates.length > 0 && (
                      <ul className="text-muted-foreground mt-1 space-y-0.5 text-[10.5px]">
                        {resolution.groupCandidates.map((c) => (
                          <li key={c.id} className="truncate">
                            · {c.name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell>
                    {l.line_type === 'inventory' ? (
                      <div className="flex min-w-[220px] flex-col gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <ItemCombobox
                            items={comboOptionsFor(effectiveItemId ?? null)}
                            value={effectiveItemId ?? null}
                            onChange={(id) => setLineItem(l.id, id)}
                            className="min-w-[200px]"
                            // Once the import is approved/canceled the mapping is
                            // final (the PO already exists) — show it read-only.
                            disabled={!canApprove}
                          />
                          {isUnmappedInventory && canApprove && (
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
                        {hasSuggestion && canApprove && (
                          // Advisory only — never pre-selects the combobox above
                          // (value stays derived from item_id/override, never
                          // suggested_item_id). Default stays create-new; this
                          // is the ONLY way a suggestion becomes a link.
                          <div className="border-border bg-muted/40 flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
                            <Sparkles className="text-muted-foreground h-3 w-3 shrink-0" />
                            <span>
                              Possible match:{' '}
                              <strong className="font-medium">
                                {l.suggestionLabel ?? 'an existing item'}
                              </strong>{' '}
                              — Use it?
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 shrink-0 px-2 text-[10.5px]"
                              onClick={() => acceptSuggestion(l.id, l.suggested_item_id!)}
                            >
                              Use existing
                            </Button>
                          </div>
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
                      disabled={!canApprove}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {canApprove && (
        <StockImpactPreview
          lines={lines}
          overrides={overrides}
          items={items}
          skuTotalBySku={skuTotalBySku}
        />
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
        // Both KEEP ('') and GENERIC mean "born with no charter" for a BRAND NEW
        // item — there is no existing ownership to keep. Identical to the
        // pre-2026-07-22 behaviour of this call.
        // Tri-state, matching the approve payload above: '' is the "keep each
        // item's current charter" default and must reach the service as
        // UNDEFINED (no intent), never null — null is the explicit Generic
        // instruction and would re-point existing items onto Generic siblings.
        charterId={charterId === '' ? undefined : charterId === CHARTER_GENERIC ? null : charterId}
        locationId={locationId || null}
        itemType={createItemType}
        lines={createLines}
        categories={categories ?? []}
        resolutions={resolutions}
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
