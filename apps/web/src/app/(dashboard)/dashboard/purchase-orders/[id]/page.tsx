import { Download } from 'lucide-react';
import { notFound } from 'next/navigation';

import { ItemThumb } from '@/components/items/item-thumb';
import { DetailSection, DetailSectionMeta } from '@/components/patterns/detail-section';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { MakeRecurringButton } from '@/components/po/make-recurring-button';
import { PoReceiveDialog } from '@/components/po/po-receive-dialog';
import { PoNotesEditor } from '@/components/po/po-notes-editor';
import { PoRenameButton } from '@/components/po/po-rename-button';
import { PoSetDestination } from '@/components/po/po-set-destination';
import { PoStatusBadge } from '@/components/po/po-status-badge';
import { PoActions } from '@/components/po/po-actions';
import { PoFileActions, PoAttachmentsList } from '@/components/po/po-attachments-panel';
import { ReceiptHistory } from '@/components/po/receipt-history';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PoAccessDenied } from '@/components/po/po-access-denied';
import { requireOrgContext } from '@/lib/auth/session';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { loadSizeRunGroups } from '@/server/services/size-run-display';
import { LocationsService } from '@/server/services/locations';
import { PoAttachmentsService } from '@/server/services/po-attachments';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import { ReceivingService } from '@/server/services/receiving';
import { ReceivingChecklistService } from '@/server/services/receiving-checklist';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';
import { formatCurrency, formatRelative } from '@/lib/utils';

import {
  can,
  dbPermissionRefusedCopy,
  formatCalendarDate,
  isManagerOrAbove,
  liveChecklistVersion,
  RECEIVE_MANAGER_POSTS_COPY,
} from '@stockpilot/core';

/** The page area (DESIGN-SPEC 5.3 and 4): max 1320, 28 / 32 / 64, 16 px gutters on a phone. */
const PAGE = 'mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7';

export default async function PoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Gate in-page BEFORE any service call. poSvc.get() asserts
  // purchase_orders:read and THROWS forbidden when revoked; a thrown RSC trips
  // the error boundary ("Something broke loading this page") because Next
  // renders this page concurrently with the section layout, so the layout's
  // gate can't catch it first. Checking here renders the clean denial instead.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'purchase_orders:read')) {
    return <PoAccessDenied />;
  }

  const [
    poSvc,
    inventorySvc,
    suppliersSvc,
    locationsSvc,
    receivingSvc,
    warehousesSvc,
    poAttachSvc,
    checklistSvc,
  ] = await Promise.all([
    PurchaseOrdersService.forCurrentUser(),
    InventoryService.forCurrentUser(),
    SuppliersService.forCurrentUser(),
    LocationsService.forCurrentUser(),
    ReceivingService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    PoAttachmentsService.forCurrentUser(),
    ReceivingChecklistService.forCurrentUser(),
  ]);

  // po.get() and all the PO-INDEPENDENT queries (they need only `id`, not the
  // fetched PO row) start together — one round trip instead of two sequential
  // stages. Only referencedItems below depends on po.lines, so it still waits.
  // (P13) The not_found → notFound() handling stays scoped to po.get().
  const [result, suppliers, locations, receiptData, warehouses, attachments, checklists] =
    await Promise.all([
      poSvc.get(id).catch((e) => {
        if (e instanceof ServiceError && e.code === 'not_found') notFound();
        throw e;
      }),
      suppliersSvc.listForLookups(),
      // UNFILTERED, deliberately. This list is not a picker — it exists only to
      // look the PO's own `destination_location_id` back up (below) so the page
      // can read its name and derive the receiving warehouse. With
      // `excludeSystem: true`, `isUserFacingLocation` dropped kind 'staging' and
      // 'unplaced', so a PO destined for a warehouse's STAGING bucket resolved to
      // undefined: Destination rendered as an em-dash, the Receive button vanished
      // (it needs `warehouseId`), and the "destination isn't linked to a
      // warehouse" card appeared — whose own picker resolves back to staging, so
      // the offered fix looped. The database was correct the whole time.
      //
      // The pickers that OFFER a destination still filter; staging must never be
      // an operator's choice. Reading one back is a different question from
      // offering it, and `isUserFacingLocation` stays untouched.
      locationsSvc.list(),
      receivingSvc.listForPurchaseOrder(id),
      warehousesSvc.listNames(),
      poAttachSvc.list(id),
      // The receiving checklist's versions and this PO's runs (F4-1). Never
      // throws: a failed read answers { ok: false } and the receipts say so.
      checklistSvc.forPurchaseOrder(id),
    ]);

  const { po, lines } = result;
  const canManagePo = can(ctx, 'purchase_orders:manage');

  // Load only the items actually referenced on this PO (lines + receipts)
  // instead of the whole inventory. Caps memory + DB scan to ~PO size.
  const lineItemIds = lines.map((l) => l.item_id as string).filter(Boolean);
  const receiptItemIds = receiptData.lines.map((l) => l.item_id as string).filter(Boolean);
  const referencedIds = Array.from(new Set([...lineItemIds, ...receiptItemIds]));
  // includeDeleted: this is historical display — a since-deleted (e.g. auto-
  // cleaned-up) item should still show its name on past lines/receipts.
  const referencedItems = await inventorySvc.byIds(referencedIds, { includeDeleted: true });
  const itemsById = new Map(referencedItems.map((i) => [i.id, i]));

  const supplier = suppliers.find((s) => s.id === po.supplier_id);
  const location = locations.find((l) => l.id === po.destination_location_id);

  // Receipts post against a warehouse. Derive it from the destination
  // location's warehouse_id. If the PO has no destination, the receive button
  // is disabled with a helpful tooltip.
  const warehouseId = (location?.warehouse_id as string | null | undefined) ?? null;

  const status = po.status as string;
  const receivableHere =
    (status === 'ordered' || status === 'expected_inbound' || status === 'partially_received') &&
    warehouseId !== null;
  // Receiving and reversing a receipt ask stock:adjust (ReceivingService
  // asserts it; since 0395 the database's receipt functions refuse a direct
  // call without it too). This page offered Receive items to everyone who can
  // read purchase orders, viewers included, and Reverse to every manager by
  // role, and each was then refused (small fixes slice 2 review). Without
  // the permission the page says why, in the words the server's refusal maps
  // to, where the receiving hint would be.
  const canAdjustStock = can(ctx, 'stock:adjust');
  // F4-1: Receive and Post receipt only for someone the ledger lets post, a
  // manager or above with stock:adjust (core receivingGate, the predicate
  // ReceivingService.postReceipt and the phone share).
  const gate = checklistSvc.gate();
  const canReceive = receivableHere && gate.canPostReceipt;
  // The receive dialog stays mounted for a poster even when nothing is left
  // to receive (desk check F1): a post that completes the PO refreshes this
  // page as 'received', and the Posted panel the dialog holds must not vanish
  // under the person. It shows its Receive items button only while canReceive.
  const keepReceiveDialog = gate.canPostReceipt && warehouseId !== null;
  // The What's New registry test (lib/releases/registry.test.ts) pins this
  // statement on one line, so Prettier leaves it as written.
  // prettier-ignore
  const receiveRefusal = receivableHere && !canAdjustStock ? dbPermissionRefusedCopy('receipt_post') : null;
  // With the permission but below manager, the ledger still refuses a post
  // (F4-1), so the page says who posts receipts. Without the permission the
  // sentence above says what is missing, as it did before F4-1.
  const managerPostsNote =
    receivableHere && canAdjustStock && !gate.canPostReceipt ? RECEIVE_MANAGER_POSTS_COPY : null;
  const canReverse = isManagerOrAbove(ctx.role) && canAdjustStock;
  const liveChecklist = checklists.ok ? liveChecklistVersion(checklists.versions) : null;

  const lineRows = lines.map((l) => {
    const item = itemsById.get(l.item_id as string);
    return {
      id: l.id as string,
      itemId: l.item_id as string,
      name: item?.name ?? 'Unknown item',
      sku: item?.sku ?? '',
      quantityOrdered: l.quantity_ordered as number,
      quantityReceived: l.quantity_received as number,
      unitCost: l.unit_cost as number,
      lineTotal: l.line_total as number,
      trackingType: (item?.tracking_type ?? 'none') as
        'none' | 'lot' | 'serial' | 'serial_optional',
      // Sports variant identity (0298) — NULL on every line in every
      // non-sports org, which keeps the receive dialog's flat renderer the
      // default path.
      groupId: item?.group_id ?? null,
      variantSize: item?.variant_size ?? null,
      imageUrl: (l.imageUrl as string | null | undefined) ?? null,
      previewUrl: (l.previewUrl as string | null | undefined) ?? null,
    };
  });

  // Size-run receiving (Task 16): resolve the product groups this PO's lines
  // belong to, so the receive dialog can lay a run out as one block with
  // per-size ordered/received. No group ids (every non-sports PO) = no query.
  const receiveGroups = await loadSizeRunGroups(lineRows.map((l) => l.groupId));

  const supplierName = (supplier?.name as string | undefined) ?? null;
  // The receiving hint, or the reason receiving is not offered, beside the
  // Line items title (the reference's card header meta).
  const receiveNote =
    canReceive && warehouseId
      ? 'Items arrived? Use “Receive items” to record what was received.'
      : (receiveRefusal ?? managerPostsNote);

  return (
    <div className={PAGE}>
      {/* The record's header (DESIGN-SPEC 6.1 and 6.18): the PO number is the
          page's h1 in mono, the rename pencil and the status label beside it,
          the supplier and when it was created under it, and the actions on
          the right, wrapping under the title on a narrow screen so the number
          is never squeezed. Mark as ordered is the one ink-filled button. */}
      <PageHeader
        back={
          <PageHeaderBackLink href="/dashboard/purchase-orders">
            ← Back to purchase orders
          </PageHeaderBackLink>
        }
        title={
          <span className="font-mono text-[24px] font-medium tracking-normal">
            {po.po_number as string}
          </span>
        }
        titleAside={
          <span className="flex items-center gap-2">
            {status !== 'cancelled' && (
              <PoRenameButton poId={id} currentNumber={po.po_number as string} />
            )}
            <PoStatusBadge status={status} />
          </span>
        }
        meta={
          <>
            {supplierName ? <span className="text-ink-2">{supplierName}</span> : null}
            {supplierName ? <span aria-hidden="true">·</span> : null}
            <span>created {formatRelative(po.created_at as string)}</span>
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <a href={`/api/purchase-orders/${id}/pdf`} target="_blank" rel="noopener noreferrer">
                <Download className="h-4 w-4" /> Download PDF
              </a>
            </Button>
            <PoFileActions
              purchaseOrderId={id}
              organizationId={ctx.organizationId}
              canManage={canManagePo}
              hasAttachments={attachments.length > 0}
            />
            <MakeRecurringButton poId={id} />
            <PoActions poId={id} status={status} part="secondary" />
          </>
        }
        commitAction={<PoActions poId={id} status={status} part="commit" />}
      />

      {/*
        Show the destination-fix card whenever we can't resolve a warehouse to
        receive against — covering BOTH a missing destination AND a destination
        location that has no warehouse_id. The latter is the dead-end that hid
        the Receive button with no way out: the destination was set, so the old
        `!destination_location_id` gate never fired. */}
      {warehouseId === null &&
        (status === 'expected_inbound' ||
          status === 'ordered' ||
          status === 'partially_received' ||
          status === 'draft') && (
          <PoSetDestination
            poId={id}
            warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
            hasUnreceivableDestination={po.destination_location_id != null}
          />
        )}

      {/* Two columns once the space beside the sidebar holds them (about 2 x
          420 + 16 px of content, DESIGN-SPEC 8), measured on the content, not
          the window; one column below that, in the same order: Line items,
          Receipts, Summary, Attachments. */}
      <div className="@container min-w-0">
        <div className="@min-[856px]:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)] grid items-start gap-4">
          <div className="flex min-w-0 flex-col gap-4">
            <DetailSection
              headingId="po-line-items-heading"
              title="Line items"
              aside={
                receiveNote ? (
                  <DetailSectionMeta className="max-w-sm">{receiveNote}</DetailSectionMeta>
                ) : undefined
              }
              flush
              footer={
                <>
                  {/* The lines' own sum. The PO's Total, which also carries an
                      import's charges, stays in Summary beside it. */}
                  <div className="text-muted-foreground text-[13.5px]">
                    Subtotal
                    <span className="text-foreground ml-1.5 font-mono font-medium tabular-nums">
                      {formatCurrency(po.subtotal as number)}
                    </span>
                  </div>
                  {keepReceiveDialog && warehouseId && (
                    <PoReceiveDialog
                      poId={id}
                      poNumber={po.po_number as string}
                      warehouseId={warehouseId}
                      lines={lineRows}
                      groups={receiveGroups}
                      receivable={canReceive}
                      checklist={
                        liveChecklist
                          ? {
                              versionNumber: liveChecklist.versionNumber,
                              title: liveChecklist.title,
                            }
                          : null
                      }
                      canRecordChecklist={gate.canRecordChecklist}
                    />
                  )}
                </>
              }
            >
              <LineItems rows={lineRows} />
            </DetailSection>

            <DetailSection title="Receipts" bodyClassName="max-sm:px-3">
              <ReceiptHistory
                receipts={receiptData.receipts}
                lines={receiptData.lines}
                items={Object.fromEntries(
                  referencedItems.map((i) => [i.id, { name: i.name, sku: i.sku }]),
                )}
                canReverse={canReverse}
                checklists={checklists}
                canRecordChecklist={gate.canRecordChecklist}
                poId={id}
                canReceive={canReceive}
              />
            </DetailSection>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <DetailSection title="Summary" flush>
              <KeyValueList>
                <KeyValueRow label="Supplier">{supplierName ?? '—'}</KeyValueRow>
                <KeyValueRow label="Destination">{(location?.name as string) ?? '—'}</KeyValueRow>
                {/* A DAY stored as its UTC midnight, read in UTC: in the server's
                    zone it was the day before on any server west of UTC. */}
                <KeyValueRow label="Expected">
                  {formatCalendarDate(po.expected_at as string | null, {
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                  })}
                </KeyValueRow>
                <KeyValueRow label="Subtotal">{formatCurrency(po.subtotal as number)}</KeyValueRow>
                <KeyValueRow label="Total" valueClassName="font-semibold">
                  {formatCurrency(po.total as number)}
                </KeyValueRow>
              </KeyValueList>
              <PoNotesEditor poId={id} currentNotes={(po.notes as string | null) ?? null} />
            </DetailSection>

            <PoAttachmentsList
              purchaseOrderId={id}
              attachments={attachments}
              canManage={canManagePo}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

type LineRow = {
  id: string;
  itemId: string;
  name: string;
  sku: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  lineTotal: number;
  imageUrl: string | null;
  previewUrl: string | null;
};

/** Received against ordered, 0-100 (an over-receipt fills the bar). */
function receivedPercent(received: number, ordered: number): number {
  if (!(ordered > 0)) return received > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (received / ordered) * 100));
}

/**
 * The PO's lines in M4's row look (DESIGN-SPEC 6.18): the 32 px photo with its
 * hover preview, the name, then the SKU with the unit cost and the line total in
 * mono, and on the right what was received against what was ordered over a
 * thin bar drawn from those two numbers. Every value the old columns held
 * (Image, Item, SKU, Ordered, Received, Unit cost, Total) is still printed,
 * and named for a screen reader. All lines render (no pagination).
 *
 * The rows hold no control, so when a line is wider than the screen (an ISBN
 * at 320 px, a SKU built from a book's title) the table's scroll area is a
 * Tab stop; it is named by the card's Line items heading. The space after the
 * SKU's separator sits outside its no-wrap span, so the line can break there:
 * an ISBN or an automatic SKU then fits from 360 px up. That needs the photo
 * column at 58 px on a phone: below sm the photo's cell keeps 8 px on its
 * right (18 + 32 + 8), since 12 px made it 62 px and a 16-character automatic
 * SKU's line 2 px wider than the card at 360 px.
 */
function LineItems({ rows }: { rows: LineRow[] }) {
  return (
    <Table scrollLabelledBy="po-line-items-heading">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {/* The 18 px gutter and the 32 px line photo (FX9). */}
          <TableHead className="w-[50px] first:pl-[18px]">
            <span className="sr-only">Image</span>
          </TableHead>
          <TableHead className="pl-0">Item</TableHead>
          <TableHead className="text-right last:pr-[18px] sm:w-[168px] sm:whitespace-nowrap">
            Received / ordered
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((l) => {
          const unitCost = formatCurrency(l.unitCost);
          const lineTotal = formatCurrency(l.lineTotal);
          return (
            <TableRow key={l.id} className="hover:bg-transparent" data-testid="po-line">
              <TableCell className="py-2.5 first:pl-[18px] max-sm:pr-2">
                <ItemThumb
                  imageUrl={l.imageUrl}
                  previewUrl={l.previewUrl}
                  alt={l.name}
                  size="line"
                  itemId={l.itemId}
                />
              </TableCell>
              <TableCell className="py-2.5 pl-0">
                <p className="text-foreground font-medium leading-5 [overflow-wrap:anywhere]">
                  {l.name}
                </p>
                <p className="text-muted-foreground mt-0.5 font-mono text-[12px] tabular-nums leading-[18px]">
                  {l.sku ? (
                    <>
                      <span className="whitespace-nowrap">{l.sku} ·</span>{' '}
                    </>
                  ) : null}
                  <span aria-hidden="true" data-testid="po-line-money">
                    <span className="whitespace-nowrap">{unitCost} ea</span> ·{' '}
                    <span className="whitespace-nowrap">{lineTotal}</span>
                  </span>
                  <span className="sr-only">
                    Unit cost {unitCost}, total {lineTotal}
                  </span>
                </p>
              </TableCell>
              <TableCell className="py-2.5 last:pr-[18px]">
                <div className="ml-auto w-24 max-w-full sm:w-[120px]">
                  <div className="flex items-baseline justify-between gap-2 font-mono text-[12px] tabular-nums">
                    <span className="text-foreground">
                      <span className="sr-only">Received </span>
                      {l.quantityReceived}
                    </span>
                    <span className="text-muted-foreground">
                      <span aria-hidden="true">/ </span>
                      <span className="sr-only">of </span>
                      {l.quantityOrdered}
                      <span className="sr-only"> ordered</span>
                    </span>
                  </div>
                  {/* The fill has no radius of its own: the track rounds its
                      start and its end is square, as the reference draws it
                      (DESIGN-SPEC 6.11; FX13). */}
                  <div
                    aria-hidden="true"
                    className="bg-line-strong mt-1 h-1 overflow-hidden rounded-sm"
                  >
                    <div
                      className="bg-accent h-full"
                      style={{
                        width: `${receivedPercent(l.quantityReceived, l.quantityOrdered)}%`,
                      }}
                    />
                  </div>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
