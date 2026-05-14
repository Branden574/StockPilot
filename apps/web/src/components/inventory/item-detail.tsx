import { Box, Boxes, DollarSign, GraduationCap, Hash, History, MapPin, Printer, Tag, Truck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActivityFeed } from '@/components/inventory/activity-feed';
import { AuditTimeline } from '@/components/audit/audit-timeline';
import { BarcodeDisplay } from '@/components/inventory/barcode-display';
import { ImageUploader } from '@/components/inventory/image-uploader';
import { ItemDetailTabs } from '@/components/inventory/item-detail-tabs';
import {
  parseDetailTab,
  type DetailTabId,
} from '@/components/inventory/item-detail-tabs-shared';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { StockAdjustDialog } from '@/components/inventory/stock-adjust-dialog';
import { StockTransferDialog } from '@/components/inventory/stock-transfer-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ActivityService } from '@/server/services/activity';
import { CategoriesService } from '@/server/services/categories';
import { ServiceError, withContext } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { ItemImagesService } from '@/server/services/item-images';
import { LocationsService } from '@/server/services/locations';
import { SuppliersService } from '@/server/services/suppliers';
import { formatGrade, getCrateColor, readBookStorage } from '@/lib/book-storage';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';

import { hasPermission } from '@stockpilot/core';


interface ItemDetailProps {
  id: string;
  backHref: string;
  backLabel: string;
  /**
   * Where the "Edit" button links. Defaults to the items-tab edit route
   * (/dashboard/inventory/[id]/edit). The Books tab passes a books-tab
   * edit route so the book-specific form (ISBN, grade, rack, crate,
   * author) is shown instead of the generic product form.
   */
  editHref?: string;
  /**
   * Selected tab, from `?tab=overview|movements|activity`. Defaults to
   * `overview` when missing or unknown. The page passes this through
   * from its own `searchParams`.
   */
  tab?: string;
  /**
   * Encoded list URL the user came from. Threaded into the "Edit"
   * link so the edit page can offer the same round-trip back.
   * Comes pre-validated by the page (safeReturnPath).
   */
  returnParam?: string;
}

export async function ItemDetail({ id, backHref, backLabel, editHref, tab, returnParam }: ItemDetailProps) {
  const activeTab: DetailTabId = parseDetailTab(tab);

  const [ctx, inventorySvc, activitySvc, imagesSvc, categoriesSvc, locationsSvc, suppliersSvc] =
    await Promise.all([
      withContext(),
      InventoryService.forCurrentUser(),
      ActivityService.forCurrentUser(),
      ItemImagesService.forCurrentUser(),
      CategoriesService.forCurrentUser(),
      LocationsService.forCurrentUser(),
      SuppliersService.forCurrentUser(),
    ]);

  let item;
  try {
    item = await inventorySvc.get(id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [categories, locations, suppliers, activity, imageRows] = await Promise.all([
    categoriesSvc.list(),
    locationsSvc.list(),
    suppliersSvc.list(),
    activitySvc.forItem(id, 50),
    imagesSvc.list(id),
  ]);
  const signed = await imagesSvc.signedUrls(imageRows.map((r) => r.storage_path as string));
  const images = imageRows.map((r) => ({
    id: r.id as string,
    url: signed.get(r.storage_path as string) ?? '',
    isPrimary: Boolean(r.is_primary),
  }));

  const category = categories.find((c) => c.id === item.category_id);
  const location = locations.find((l) => l.id === item.primary_location_id);
  const supplier = suppliers.find((s) => s.id === item.supplier_id);

  const value = (item.quantity_on_hand as number) * (item.unit_cost as number);

  // ── Last-updated-by footer ──────────────────────────────────────────
  // Resolve the user who last touched the row (if any). RLS lets org
  // members read user_profiles within their org, so this single lookup
  // is safe and cheap.
  const updatedById = (item as { updated_by?: string | null }).updated_by ?? null;
  const updatedAt = (item as { updated_at?: string | null }).updated_at ?? null;
  let updatedByName: string | null = null;
  if (updatedById) {
    const { data } = await ctx.supabase
      .from('user_profiles')
      .select('full_name, email')
      .eq('id', updatedById)
      .maybeSingle();
    const row = data as { full_name?: string | null; email?: string | null } | null;
    updatedByName = (row?.full_name?.trim() || row?.email?.trim()) ?? null;
  }

  // Filter for the Movements tab — kind === 'movement' from the unified
  // ActivityService feed is exactly the stock_movements rows.
  const movementEvents = activity.filter((e) => e.kind === 'movement');

  // Permission gates for the sticky-header action row. Viewers see the
  // detail page (read-only) but no Edit / Adjust / Transfer buttons.
  // Server-layer assertPermission still throws if a request somehow
  // bypasses this — these flags just hide the UI surfaces.
  const canEditItem = hasPermission(ctx.role, 'items:update');
  const canAdjustStock = hasPermission(ctx.role, 'stock:adjust');
  const canTransferStock = hasPermission(ctx.role, 'stock:transfer');

  return (
    <div className="container mx-auto max-w-5xl px-4 pb-6 sm:px-6 sm:pb-8">
      {/* ── Sticky header ─────────────────────────────────────────────
          Pins to top-0 of the scrolling <main> in DashboardShell.
          The dashboard Topbar lives OUTSIDE that scroll container
          (sibling above <main>), so the sticky should pin flush
          against main's top edge — which is already right under the
          topbar visually. Using top-14 here would double-count the
          topbar height and produce a 56px gap where scrolled content
          leaks through above the sticky. */}
      <div className="bg-card border-border sticky top-0 z-20 -mx-4 border-b px-4 py-4 sm:-mx-6 sm:px-6">
        <div className="mb-3">
          <Link
            href={backHref}
            className="text-muted-foreground hover:text-foreground inline-flex items-center text-sm"
          >
            ← {backLabel}
          </Link>
        </div>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl">
                {item.name as string}
              </h1>
              <StockStatusBadge
                quantity={item.quantity_on_hand as number}
                reorderPoint={item.reorder_point as number}
                itemStatus={item.status as 'active' | 'archived' | 'discontinued'}
              />
            </div>
            <p className="text-muted-foreground mt-1 break-all font-mono text-xs">
              {item.sku as string}
            </p>
          </div>
          {/*
            Action buttons: on small screens, scroll horizontally as a
            single row instead of wrapping into 2-3 stacked rows that
            push the rest of the page off the fold. Inner div uses
            `w-max` so children keep their natural width inside the
            scroll viewport.
          */}
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <div className="flex w-max gap-2 sm:flex-wrap">
              {canEditItem && (
                <Button asChild variant="outline" size="sm" className="sm:size-auto">
                  <Link
                    href={
                      (() => {
                        const base = editHref ?? `/dashboard/inventory/${id}/edit`;
                        // Append the return param so editing → save still bounces
                        // back to the same list URL the user came from.
                        return returnParam
                          ? `${base}?return=${encodeURIComponent(returnParam)}`
                          : base;
                      })()
                    }
                  >
                    Edit
                  </Link>
                </Button>
              )}
              <BarcodeDisplay
                itemId={id}
                itemName={item.name as string}
                sku={item.sku as string}
                barcode={(item.barcode as string | null) ?? null}
              />
              <Button asChild variant="outline" size="sm" className="sm:size-auto">
                <Link href={`/dashboard/inventory/labels?items=${id}`}>
                  <Printer className="h-4 w-4" /> Print label
                </Link>
              </Button>
              {canAdjustStock && (
                <StockAdjustDialog
                  itemId={id}
                  itemName={item.name as string}
                  currentQuantity={item.quantity_on_hand as number}
                />
              )}
              {canTransferStock && locations.length >= 2 && (
                <StockTransferDialog
                  itemId={id}
                  itemName={item.name as string}
                  currentQuantity={item.quantity_on_hand as number}
                  currentLocationId={(item.primary_location_id as string | null) ?? null}
                  locations={locations.map((l) => ({
                    id: l.id as string,
                    name: l.name as string,
                    warehouse_id: (l.warehouse_id as string | null) ?? null,
                  }))}
                />
              )}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <ItemDetailTabs activeTab={activeTab} />
        </div>
      </div>

      {/* ── Tab panels ────────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <div
          role="tabpanel"
          id="item-detail-panel-overview"
          aria-labelledby="item-detail-tab-overview"
        >
          <div className="mt-6 grid gap-4 sm:mt-8 sm:gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <DetailRow icon={Boxes} label="On hand">
                  <span className="text-base font-semibold tabular-nums">
                    {formatNumber(item.quantity_on_hand as number)} {item.unit_of_measure as string}
                  </span>
                  <StockStatusBadge
                    quantity={item.quantity_on_hand as number}
                    reorderPoint={item.reorder_point as number}
                    itemStatus={item.status as 'active' | 'archived' | 'discontinued'}
                  />
                </DetailRow>
                <DetailRow icon={DollarSign} label="Value">
                  <span className="text-base tabular-nums">{formatCurrency(value)}</span>
                  <span className="text-muted-foreground text-xs">
                    @ {formatCurrency(item.unit_cost as number)} unit cost
                  </span>
                </DetailRow>
                <Separator />
                <DetailRow icon={Tag} label="Category">
                  {category ? (
                    <span>{category.name as string}</span>
                  ) : (
                    <span className="text-muted-foreground">Uncategorized</span>
                  )}
                </DetailRow>
                <DetailRow icon={MapPin} label="Location">
                  {location ? (
                    <span>{location.name as string}</span>
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                  {item.bin_location && (
                    <span className="text-muted-foreground text-xs">
                      {item.bin_location as string}
                    </span>
                  )}
                </DetailRow>
                {(() => {
                  const storage = readBookStorage(
                    item.custom_fields as Record<string, unknown> | null,
                  );
                  const color = getCrateColor(storage.crateColor);
                  const cf = (item.custom_fields as Record<string, unknown> | null) ?? {};
                  const isBook = item.item_type === 'book';
                  // For books, ISBN is stored in inventory_items.barcode — the
                  // edit form's "ISBN" label binds to the same field as
                  // "Barcode" for non-books, and bulk-ISBN import also writes
                  // the ISBN to `barcode` (services/books-import.ts:85).
                  // custom_fields.isbn / .isbn13 / .isbn10 are legacy fallbacks
                  // from older import paths.
                  const isbnRaw = isBook
                    ? ((item.barcode as string | null) ?? '') ||
                      (typeof cf.isbn === 'string' && cf.isbn) ||
                      (typeof cf.isbn13 === 'string' && cf.isbn13) ||
                      (typeof cf.isbn10 === 'string' && cf.isbn10) ||
                      ''
                    : '';
                  const isbn = isbnRaw.trim();
                  const hasAny =
                    isBook ||
                    storage.grade ||
                    storage.rackLabel ||
                    (color && storage.crateNumber) ||
                    isbn;
                  if (!hasAny) return null;
                  return (
                    <>
                      {isBook && (
                        <DetailRow icon={Hash} label="ISBN">
                          {isbn ? (
                            <span className="font-mono tabular-nums">{isbn}</span>
                          ) : (
                            <span className="text-muted-foreground">Not set</span>
                          )}
                        </DetailRow>
                      )}
                      {storage.grade && (
                        <DetailRow icon={GraduationCap} label="Grade">
                          <span>{formatGrade(storage.grade)}</span>
                        </DetailRow>
                      )}
                      {storage.rackLabel && (
                        <DetailRow icon={MapPin} label="Rack">
                          <span className="font-mono tabular-nums">{storage.rackLabel}</span>
                        </DetailRow>
                      )}
                      {color && storage.crateNumber && (
                        <DetailRow icon={Box} label="Crate">
                          <span className="inline-flex items-center gap-2">
                            <span
                              aria-hidden
                              className="border-border inline-block h-3 w-3 rounded-full border"
                              style={{ backgroundColor: color.hex }}
                            />
                            <span>
                              {color.label}{' '}
                              <span className="font-mono tabular-nums">{storage.crateNumber}</span>
                            </span>
                          </span>
                        </DetailRow>
                      )}
                    </>
                  );
                })()}
                <DetailRow icon={Truck} label="Supplier">
                  {supplier ? (
                    <span>{supplier.name as string}</span>
                  ) : (
                    <span className="text-muted-foreground">No supplier</span>
                  )}
                </DetailRow>
                {(item.description as string | null) && (
                  <>
                    <Separator />
                    <div className="space-y-1.5">
                      <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                        Description
                      </p>
                      <p className="whitespace-pre-wrap text-sm">{item.description as string}</p>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Reorder</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Stat
                  label="Reorder at"
                  value={`${formatNumber(item.reorder_point as number)} ${item.unit_of_measure as string}`}
                />
                <Stat
                  label="Reorder qty"
                  value={`${formatNumber(item.reorder_quantity as number)} ${item.unit_of_measure as string}`}
                />
                <Stat label="Retail price" value={formatCurrency(item.retail_price as number)} />
                <Stat
                  label="Status"
                  value={(item.status as string).replace(/^./, (s) => s.toUpperCase())}
                />
              </CardContent>
            </Card>
          </div>

          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="text-base">Images</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Fallback: when there are no rows in item_images yet but the
                  ISBN-import pipeline stashed a cover URL on the row's
                  custom_fields, render it inline so the detail page shows
                  the cover the list page is already showing. The uploader
                  still works underneath — uploading saves to item_images
                  and supersedes this preview. */}
              {images.length === 0
                ? (() => {
                    const cf = (item as { custom_fields?: Record<string, unknown> | null })
                      .custom_fields;
                    const cfThumb =
                      cf && typeof cf === 'object' && typeof cf.thumbnail_url === 'string'
                        ? (cf.thumbnail_url as string)
                        : null;
                    return cfThumb ? (
                      <div className="mb-4 flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={cfThumb}
                          alt=""
                          width={64}
                          height={88}
                          loading="lazy"
                          decoding="async"
                          className="rounded-sm border border-border bg-background object-cover"
                          style={{ aspectRatio: '3/4' }}
                        />
                        <div className="text-muted-foreground text-[12px] leading-relaxed">
                          <div className="text-foreground mb-0.5 text-[12.5px] font-medium">
                            Cover from ISBN lookup
                          </div>
                          Imported from a third-party source (Google Books / Open Library / Library
                          of Congress). Upload a photo below to replace it with your own — the
                          uploaded image becomes the primary.
                        </div>
                      </div>
                    ) : null;
                  })()
                : null}
              <ImageUploader itemId={id} initialImages={images} />
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'movements' && (
        <div
          role="tabpanel"
          id="item-detail-panel-movements"
          aria-labelledby="item-detail-tab-movements"
        >
          <Card className="mt-6 sm:mt-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" /> Stock movements
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityFeed events={movementEvents} />
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'activity' && (
        <div
          role="tabpanel"
          id="item-detail-panel-activity"
          aria-labelledby="item-detail-tab-activity"
        >
          <Card className="mt-6 sm:mt-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" /> Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityFeed events={activity} />
            </CardContent>
          </Card>

          {/* AuditTimeline renders null when there are no rows, so this
              block disappears on items with no recorded metadata edits.
              Lives inside the Activity tab so a deep link to
              ?tab=activity shows both the merged feed AND the
              admin-facing audit log together. */}
          <div className="mt-6">
            <AuditTimeline
              entityType="inventory_item"
              entityId={id}
              limit={20}
              wrapperTitle="Recent activity"
            />
          </div>
        </div>
      )}

      {/* ── Footer: last updated by ────────────────────────────────── */}
      {updatedAt && (
        <p className="text-muted-foreground mt-8 text-center text-xs">
          {updatedByName
            ? `Last updated by ${updatedByName} · ${formatRelative(updatedAt)}`
            : `Last updated ${formatRelative(updatedAt)}`}
        </p>
      )}
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="text-muted-foreground mt-0.5 h-4 w-4" />
      <div className="flex-1 space-y-0.5">
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {label}
        </p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
