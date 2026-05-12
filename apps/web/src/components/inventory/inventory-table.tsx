'use client';

import { ChevronDown, Download, Loader2, Pin, Plus, Search, Users, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { BulkActions } from '@/components/inventory/bulk-actions';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import {
  createSavedViewAction,
  deleteSavedViewAction,
  setActiveWarehouseAction,
  toggleSavedViewShareAction,
} from '@/server/actions/saved-views';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { getCrateColor, readBookStorage } from '@/lib/book-storage';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface Item {
  id: string;
  sku: string;
  name: string;
  status: 'active' | 'archived' | 'discontinued';
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost: number;
  retail_price: number;
  category_id: string | null;
  primary_location_id: string | null;
  updated_at: string;
  custom_fields?: Record<string, unknown> | null;
  /** Signed URL to the primary item image, if any. Page is responsible
   * for filling this in via ItemImagesService.primaryImagesForItems. */
  image_url?: string | null;
}

interface Lookups {
  categories: Map<string, { name: string; color: string | null }>;
  locations: Map<string, { name: string }>;
}

interface InventoryTableProps {
  items: Item[];
  lookups: Lookups;
  /** Lists used by the bulk actions bar AND the new filter dropdowns.
      Passed from the page server fetch so the toolbar can render
      checkbox lists without an extra round trip. */
  categories?: Array<{ id: string; name: string }>;
  /** Locations available for the filter dropdown. */
  locations?: Array<{ id: string; name: string }>;
  suppliers?: Array<{ id: string; name: string }>;
  /** Org tag list — forwarded to BulkActions for the Add/Remove tags
      dialogs. Defaults to [] so older callers don't crash. */
  tags?: Array<{ id: string; name: string; color: string | null }>;
  total: number;
  initialQuery?: string;
  /**
   * URL prefix for the row click target. Used so the Books tab can
   * link to /dashboard/books/{id} (keeping users in the books context)
   * while the default Items tab links to /dashboard/inventory/{id}.
   */
  rowLinkPrefix?: string;
  /**
   * Base path for the filter chips ("All items / Low + critical /
   * Out of stock"). Defaults to /dashboard/inventory; pass
   * /dashboard/books from the books tab so chips don't jump tabs.
   */
  basePath?: string;
  /**
   * When true, the table renders book-specific columns: Rack
   * (number-row, e.g. "38-A") and Crate (color dot + number).
   * Driven by reading custom_fields.book_* off each row. Used by
   * the Books tab; the default Items tab leaves the columns out.
   */
  showBookFields?: boolean;
  /**
   * Whether the current viewer can create new items. Drives the
   * "+ New item/book" button that sits at the bottom right of the
   * table next to pagination. Page passes this from a
   * hasPermission(ctx.role, 'items:create') check.
   */
  canCreate?: boolean;
  /** 1-based current page. Default 1 — pagination UI hides if total ≤ pageSize. */
  page?: number;
  /** How many rows per page. Drives the page count math. */
  pageSize?: number;
  /** Per-item 14-day series (qty trend + move count) keyed by item id.
      When omitted or a row is missing, the sparkline falls back to a
      flat line at current quantity. Computed by getItemTrends in
      services/movements.ts. */
  trends?: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
  /** User's saved views for this scope. Renders as chips alongside the
      built-in All / Low / Out chips. Pass [] (or omit) for tabs that
      haven't loaded any. */
  savedViews?: SavedViewSummary[];
  /** Which scope these views belong to ('inventory' or 'books'). The
      tab page knows which it is; we forward that to the create/delete
      server actions so they revalidate the right path. */
  savedViewScope?: 'inventory' | 'books';
  /** Currently active warehouse id (from cookie via the layout). Saved
      views capture this alongside URL params so applying a view can
      restore both axes. */
  activeWarehouseId?: string | null;
  /** Current user id — used to decide whether to show owner-only
      actions (share toggle, delete) on org-shared saved views. */
  currentUserId?: string | null;
}

interface SavedViewSummary {
  id: string;
  name: string;
  state: {
    q?: string;
    status?: string;
    stock?: string;
    type?: string;
    sort?: string;
    cat?: string[];
    loc?: string[];
    warehouseId?: string | null;
  };
  /** True when shared with the whole org. Non-owner viewers see a
      read-only chip with a small Users icon. */
  isShared?: boolean;
  /** Owner's user id. Only the owner sees the delete + share-toggle
      controls on the chip; everyone else gets a click-to-apply chip. */
  ownerId?: string;
}

type SparkMode = 'qty' | 'moves';
const SPARK_MODE_KEY = 'stockpilot:inventory:sparkline-mode';

const VIEWS = ['All items', 'Low + critical', 'Out of stock'] as const;
type View = (typeof VIEWS)[number];

function paramsToView(stock: string | null): View {
  if (stock === 'low') return 'Low + critical';
  if (stock === 'out') return 'Out of stock';
  return 'All items';
}

type SortKey =
  | 'updated_desc'
  | 'updated_asc'
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'qty_desc'
  | 'qty_asc'
  | 'created_desc'
  | 'created_asc';

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'updated_desc', label: 'Last updated (newest)' },
  { value: 'updated_asc', label: 'Last updated (oldest)' },
  { value: 'name_asc', label: 'Name (A → Z)' },
  { value: 'name_desc', label: 'Name (Z → A)' },
  { value: 'sku_asc', label: 'SKU (A → Z)' },
  { value: 'sku_desc', label: 'SKU (Z → A)' },
  { value: 'qty_desc', label: 'On hand (high → low)' },
  { value: 'qty_asc', label: 'On hand (low → high)' },
  { value: 'created_desc', label: 'Created (newest)' },
  { value: 'created_asc', label: 'Created (oldest)' },
];

function paramsToSort(value: string | null): SortKey {
  const found = SORT_OPTIONS.find((o) => o.value === value);
  return found?.value ?? 'updated_desc';
}

function paramsToIdSet(params: URLSearchParams, key: string): Set<string> {
  return new Set(params.getAll(key).filter(Boolean));
}

function deriveStatus(qty: number, reorder: number): 'ok' | 'warn' | 'crit' {
  if (qty <= 0) return 'crit';
  if (reorder > 0 && qty <= reorder) return 'warn';
  return 'ok';
}

/**
 * Returns the 14-day series to plot for a row, given the active spark
 * mode and the trends map from getItemTrends. Falls back to a flat
 * line at current qty (or zero, for moves) when trends data is missing
 * — e.g. parent forgot to pass `trends`, or the item had no movements.
 */
function seriesForRow(
  itemId: string,
  currentQty: number,
  mode: SparkMode,
  trends: InventoryTableProps['trends'],
): number[] {
  const t = trends?.get(itemId);
  if (t) return mode === 'qty' ? t.qtySeries : t.moveSeries;
  return new Array<number>(14).fill(mode === 'qty' ? currentQty : 0);
}

export function InventoryTable({
  items,
  lookups,
  categories = [],
  locations = [],
  suppliers = [],
  tags = [],
  total,
  initialQuery = '',
  rowLinkPrefix = '/dashboard/inventory',
  basePath = '/dashboard/inventory',
  showBookFields = false,
  canCreate = true,
  page = 1,
  pageSize = 50,
  trends,
  savedViews = [],
  savedViewScope,
  activeWarehouseId = null,
  currentUserId = null,
}: InventoryTableProps) {
  // Sparkline mode preference. localStorage-backed so it sticks across
  // reloads + tabs but doesn't pollute URLs (it's a personal preference,
  // not a query filter). Lazy initializer reads on first mount only.
  const [sparkMode, setSparkMode] = React.useState<SparkMode>(() => {
    if (typeof window === 'undefined') return 'qty';
    const v = window.localStorage.getItem(SPARK_MODE_KEY);
    return v === 'moves' ? 'moves' : 'qty';
  });
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SPARK_MODE_KEY, sparkMode);
  }, [sparkMode]);
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = React.useState(initialQuery);
  const view = paramsToView(params.get('stock'));
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const sort = paramsToSort(params.get('sort'));
  const categoryIds = React.useMemo(
    () => paramsToIdSet(new URLSearchParams(params.toString()), 'cat'),
    [params],
  );
  const locationIds = React.useMemo(
    () => paramsToIdSet(new URLSearchParams(params.toString()), 'loc'),
    [params],
  );

  function hrefForView(v: View): string {
    const next = new URLSearchParams(params.toString());
    if (v === 'Low + critical') next.set('stock', 'low');
    else if (v === 'Out of stock') next.set('stock', 'out');
    else next.delete('stock');
    // Switching the view always reset to page 1 — staying on page 5
    // of "All items" doesn't make sense if Out-of-stock has 1 page.
    next.delete('page');
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  function hrefForPage(p: number): string {
    const next = new URLSearchParams(params.toString());
    if (p <= 1) next.delete('page');
    else next.set('page', String(p));
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  function navigateWith(mutator: (p: URLSearchParams) => void) {
    const next = new URLSearchParams(params.toString());
    mutator(next);
    // Filter / sort changes always reset to page 1 — staying on page 5
    // would be wrong if the new result set is shorter.
    next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
  }

  function setSort(key: SortKey) {
    navigateWith((next) => {
      if (key === 'updated_desc') next.delete('sort');
      else next.set('sort', key);
    });
  }

  function setMultiParam(key: 'cat' | 'loc', ids: Set<string>) {
    navigateWith((next) => {
      next.delete(key);
      for (const id of ids) next.append(key, id);
    });
  }

  const activeFilterCount = categoryIds.size + locationIds.size;
  function clearAllFilters() {
    navigateWith((next) => {
      next.delete('cat');
      next.delete('loc');
      next.delete('sort');
      next.delete('q');
      setQ('');
    });
  }

  React.useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
      // Search changes the result set — staying on page 5 isn't right
      // if the new query has fewer pages.
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(items.map((i) => i.id)) : new Set());
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const valueOnHand = items.reduce((s, it) => s + it.quantity_on_hand * it.unit_cost, 0);

  return (
    <div className="space-y-4">
      {/* Saved views — built-in chips first, then user-saved, then save button */}
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={hrefForView(v)}
            scroll={false}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors',
              v === view
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
            )}
          >
            {v}
          </Link>
        ))}
        {savedViews.map((sv) => (
          <SavedViewChip
            key={sv.id}
            view={sv}
            isActive={isSavedViewActive(sv, params, activeWarehouseId)}
            scope={savedViewScope ?? (showBookFields ? 'books' : 'inventory')}
            basePath={basePath}
            isOwner={!!currentUserId && sv.ownerId === currentUserId}
          />
        ))}
        {savedViewScope && (
          <SaveCurrentViewButton
            scope={savedViewScope}
            currentState={readCurrentState(params, activeWarehouseId)}
          />
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ed-ink-4)]" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, barcode…"
            className="h-8 pl-8 text-[12.5px]"
            aria-label="Search items"
          />
        </div>

        <SortMenu value={sort} onChange={setSort} />

        {categories.length > 0 && (
          <MultiSelectFilter
            label="Category"
            options={categories}
            selected={categoryIds}
            onChange={(ids) => setMultiParam('cat', ids)}
          />
        )}

        {locations.length > 0 && (
          <MultiSelectFilter
            label="Location"
            options={locations}
            selected={locationIds}
            onChange={(ids) => setMultiParam('loc', ids)}
          />
        )}

        {(activeFilterCount > 0 || params.get('sort') || q.trim()) && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)] hover:text-foreground"
            aria-label="Clear all filters"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}

        <ExportMenu
          params={params}
          itemType={showBookFields ? 'book' : params.get('type') ?? 'product'}
        />

        <p className="ml-auto font-mono text-[11px] tabular-nums text-[var(--ed-ink-3)]">
          {formatNumber(total)} SKUs · {formatCurrency(valueOnHand)} on hand
        </p>
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <BulkActions
          selectedIds={[...selected]}
          categories={categories}
          suppliers={suppliers}
          locations={locations}
          tags={tags}
          onClear={() => setSelected(new Set())}
          hasArchivedSelection={items.some(
            (i) => selected.has(i.id) && i.status === 'archived',
          )}
        />
      )}

      {/* Top pagination — mirrors the bottom one so users on long lists
          don't have to scroll to the bottom to flip pages. Same component,
          same URL state, same buildHref. Hides on single-page lists for
          the same reason the bottom one does. */}
      {total > pageSize && (
        <div className="flex items-center justify-end">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            buildHref={hrefForPage}
          />
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-[10px] border border-border bg-card">
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead>
            <tr className="border-b border-border">
              <th className="w-8 px-3">
                <Checkbox
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={(c) => toggleAll(c)}
                />
              </th>
              {(
                [
                  ['Item', 'left'],
                  ['SKU', 'left'],
                  ['Category', 'left'],
                  ['Location', 'left'],
                  ...(showBookFields
                    ? ([
                        ['Grade', 'left'],
                        ['Rack', 'left'],
                        ['Crate', 'left'],
                      ] as const)
                    : ([] as const)),
                  ['On hand', 'right'],
                  ['Coverage', 'left'],
                  ['14-day', 'right'],
                  ['Status', 'left'],
                  ['Updated', 'right'],
                ] as ReadonlyArray<readonly [string, 'left' | 'right']>
              ).map(([label, align]) => (
                <th
                  key={label}
                  className={cn(
                    'h-9 px-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]',
                    align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {label === '14-day' ? (
                    <SparkModeToggle mode={sparkMode} onChange={setSparkMode} />
                  ) : (
                    label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={showBookFields ? 13 : 10}
                  className="py-12 text-center text-[12.5px] text-[var(--ed-ink-4)]"
                >
                  No items match your filters.
                </td>
              </tr>
            )}
            {items.map((item) => {
              const category = item.category_id ? lookups.categories.get(item.category_id) : null;
              const location = item.primary_location_id
                ? lookups.locations.get(item.primary_location_id)
                : null;
              const status = deriveStatus(item.quantity_on_hand, item.reorder_point);
              const par = Math.max(item.reorder_point * 4, item.quantity_on_hand * 1.5, 10);
              const series = seriesForRow(
                item.id,
                item.quantity_on_hand,
                sparkMode,
                trends,
              );
              const isSelected = selected.has(item.id);

              return (
                <tr
                  key={item.id}
                  className={cn(
                    'border-b border-border transition-colors last:border-0',
                    isSelected ? 'bg-[hsl(var(--accent)/0.10)]' : 'hover:bg-muted/60',
                  )}
                >
                  <td className="px-3">
                    <Checkbox checked={isSelected} onChange={() => toggleOne(item.id)} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2.5">
                      {item.image_url ? (
                        <Image
                          src={item.image_url}
                          alt=""
                          width={56}
                          height={56}
                          sizes="28px"
                          className="h-7 w-7 shrink-0 rounded-[5px] border border-border bg-muted object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="h-7 w-7 shrink-0 rounded-[5px] border border-border"
                          style={{
                            background:
                              'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                          }}
                        />
                      )}
                      <Link
                        href={`${rowLinkPrefix}/${item.id}`}
                        className="font-medium hover:underline"
                      >
                        {item.name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 font-mono text-[11.5px] tracking-[-0.01em] text-[var(--ed-ink-3)]">
                    {item.sku}
                  </td>
                  <td className="px-3">
                    {category ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-[12px]"
                        style={category.color ? { color: category.color } : undefined}
                      >
                        {category.color && (
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: category.color }}
                          />
                        )}
                        {category.name}
                      </span>
                    ) : (
                      <span className="text-[12px] text-[var(--ed-ink-4)]">—</span>
                    )}
                  </td>
                  <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">{location?.name ?? '—'}</td>
                  {showBookFields &&
                    (() => {
                      const storage = readBookStorage(item.custom_fields);
                      const color = getCrateColor(storage.crateColor);
                      return (
                        <>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {storage.grade ? (
                              <span className="font-mono">
                                {/^\d{1,2}$/.test(storage.grade)
                                  ? `Gr ${storage.grade}`
                                  : storage.grade}
                              </span>
                            ) : (
                              <span className="text-[var(--ed-ink-4)]">—</span>
                            )}
                          </td>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {storage.rackLabel ? (
                              <span className="font-mono tabular-nums">
                                {storage.rackLabel}
                              </span>
                            ) : (
                              <span className="text-[var(--ed-ink-4)]">—</span>
                            )}
                          </td>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {color && storage.crateNumber ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  aria-hidden
                                  title={color.label}
                                  className="border-border inline-block h-2.5 w-2.5 rounded-full border"
                                  style={{ backgroundColor: color.hex }}
                                />
                                <span className="font-mono tabular-nums">
                                  {storage.crateNumber}
                                </span>
                              </span>
                            ) : (
                              <span className="text-[var(--ed-ink-4)]">—</span>
                            )}
                          </td>
                        </>
                      );
                    })()}
                  <td className="px-3 text-right font-mono tabular-nums">
                    {formatNumber(item.quantity_on_hand)}
                  </td>
                  <td className="px-3">
                    <StockBar stock={item.quantity_on_hand} par={par} status={status} />
                  </td>
                  <td className="px-3 text-right">
                    <Sparkline data={series} width={56} height={18} />
                  </td>
                  <td className="px-3">
                    <StockStatusBadge
                      quantity={item.quantity_on_hand}
                      reorderPoint={item.reorder_point}
                      itemStatus={item.status}
                    />
                  </td>
                  <td className="px-3 text-right text-[11.5px] text-[var(--ed-ink-4)]">
                    {formatRelative(item.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Pagination — hides when everything fits on one page so the
            single-screen empty/typical case stays clean. URL-driven so
            paginated views are bookmarkable + shareable. */}
        {total > pageSize ? (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            buildHref={hrefForPage}
          />
        ) : (
          <span />
        )}
        {canCreate && (
          <Button asChild>
            <Link href={`${basePath}/new`}>
              + New {showBookFields ? 'book' : 'item'}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startRow = (safePage - 1) * pageSize + 1;
  const endRow = Math.min(safePage * pageSize, total);
  const prevDisabled = safePage <= 1;
  const nextDisabled = safePage >= totalPages;
  return (
    <div className="text-muted-foreground flex items-center gap-3 text-[12px]">
      <span>
        Showing <span className="text-foreground font-medium">{startRow}</span>–
        <span className="text-foreground font-medium">{endRow}</span> of{' '}
        <span className="text-foreground font-medium">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <Button asChild variant="outline" size="sm" disabled={prevDisabled}>
          {prevDisabled ? (
            <span aria-disabled className="pointer-events-none opacity-50">
              ← Prev
            </span>
          ) : (
            <Link href={buildHref(safePage - 1)} prefetch={false}>
              ← Prev
            </Link>
          )}
        </Button>
        <span className="text-muted-foreground px-2 text-[11.5px]">
          Page {safePage} of {totalPages}
        </span>
        <Button asChild variant="outline" size="sm" disabled={nextDisabled}>
          {nextDisabled ? (
            <span aria-disabled className="pointer-events-none opacity-50">
              Next →
            </span>
          ) : (
            <Link href={buildHref(safePage + 1)} prefetch={false}>
              Next →
            </Link>
          )}
        </Button>
      </div>
    </div>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-grid h-3.5 w-3.5 place-items-center rounded-[3px] border bg-card transition-colors',
        checked ? 'border-foreground bg-foreground' : 'border-[var(--ed-line-strong)]',
      )}
    >
      {checked && (
        <span
          aria-hidden
          className="h-[7px] w-[4px] -translate-y-px rotate-[-45deg] border-b-[1.5px] border-l-[1.5px] border-background"
        />
      )}
    </button>
  );
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  const [open, setOpen] = React.useState(false);
  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0]!;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
          aria-label={`Sort by ${current.label}`}
        >
          <span className="text-[var(--ed-ink-4)]">Sort:</span>
          <span className="font-medium">{current.label}</span>
          <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1">
        <div className="flex flex-col">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                'rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted',
                opt.value === value && 'bg-muted font-medium',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  selected: Set<string>;
  onChange: (ids: Set<string>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const visible = filter.trim()
    ? options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : options;
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-[12px] transition-colors hover:border-[var(--ed-line-strong)]',
            selected.size > 0
              ? 'border-foreground text-foreground'
              : 'border-border text-[var(--ed-ink-2)]',
          )}
          aria-label={`Filter by ${label}`}
        >
          <span>{label}</span>
          {selected.size > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[10px] tabular-nums text-background">
              {selected.size}
            </span>
          )}
          <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-2">
        <div className="space-y-2">
          {options.length > 8 && (
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-7 text-[12px]"
              aria-label={`Filter ${label} options`}
            />
          )}
          <div className="max-h-[260px] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-[var(--ed-ink-4)]">
                No matches.
              </p>
            ) : (
              <ul className="flex flex-col">
                {visible.map((opt) => {
                  const isOn = selected.has(opt.id);
                  return (
                    <li key={opt.id}>
                      <button
                        type="button"
                        onClick={() => toggle(opt.id)}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted"
                      >
                        <Checkbox checked={isOn} onChange={() => toggle(opt.id)} />
                        <span className="truncate">{opt.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {selected.size > 0 && (
            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="text-[11.5px] text-[var(--ed-ink-3)] underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear {label.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ExportMenu({ params, itemType }: { params: URLSearchParams; itemType: string }) {
  const [open, setOpen] = React.useState(false);

  // "Export filtered" carries every active param verbatim (q, sort, cat[],
  // loc[], stock, status, etc.) plus scope=filtered.
  const filteredParams = new URLSearchParams(params.toString());
  filteredParams.set('scope', 'filtered');
  // Drop the page param — exports aren't paginated.
  filteredParams.delete('page');

  // "Export all" only sends type + scope=all. Server ignores everything else.
  const allParams = new URLSearchParams();
  allParams.set('type', itemType);
  allParams.set('scope', 'all');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
          aria-label="Export"
        >
          <Download className="h-3 w-3" />
          <span className="font-medium">Export</span>
          <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] p-1">
        <div className="flex flex-col">
          <a
            href={`/api/inventory/export.csv?${filteredParams.toString()}`}
            download
            onClick={() => setOpen(false)}
            className="rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted"
          >
            <div className="font-medium">Export filtered</div>
            <div className="text-[11px] text-[var(--ed-ink-4)]">
              CSV of what's currently visible
            </div>
          </a>
          <a
            href={`/api/inventory/export.csv?${allParams.toString()}`}
            download
            onClick={() => setOpen(false)}
            className="rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted"
          >
            <div className="font-medium">Export all</div>
            <div className="text-[11px] text-[var(--ed-ink-4)]">
              Full {itemType === 'book' ? 'books' : 'inventory'} dump
            </div>
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Saved views helpers + components.
// Spec: docs/superpowers/specs/2026-05-08-saved-views-design.md
// ---------------------------------------------------------------------------

function readCurrentState(
  params: URLSearchParams,
  warehouseId: string | null,
): SavedViewSummary['state'] {
  const out: SavedViewSummary['state'] = {};
  const q = params.get('q');
  if (q) out.q = q;
  const status = params.get('status');
  if (status) out.status = status;
  const stock = params.get('stock');
  if (stock) out.stock = stock;
  const type = params.get('type');
  if (type) out.type = type;
  const sort = params.get('sort');
  if (sort) out.sort = sort;
  const cat = params.getAll('cat').filter(Boolean);
  if (cat.length > 0) out.cat = cat;
  const loc = params.getAll('loc').filter(Boolean);
  if (loc.length > 0) out.loc = loc;
  if (warehouseId) out.warehouseId = warehouseId;
  return out;
}

function isSavedViewActive(
  view: SavedViewSummary,
  params: URLSearchParams,
  warehouseId: string | null,
): boolean {
  const cur = readCurrentState(params, warehouseId);
  return JSON.stringify(normalize(cur)) === JSON.stringify(normalize(view.state));
}

// Order-independent comparison helpers for state shapes.
function normalize(s: SavedViewSummary['state']) {
  return {
    q: s.q ?? '',
    status: s.status ?? '',
    stock: s.stock ?? '',
    type: s.type ?? '',
    sort: s.sort ?? '',
    cat: [...(s.cat ?? [])].sort(),
    loc: [...(s.loc ?? [])].sort(),
    warehouseId: s.warehouseId ?? '',
  };
}

function describeState(state: SavedViewSummary['state']): string {
  const parts: string[] = [];
  if (state.q) parts.push(`search "${state.q}"`);
  if (state.stock === 'low') parts.push('low stock');
  else if (state.stock === 'out') parts.push('out of stock');
  if (state.status && state.status !== 'active') parts.push(state.status);
  if (state.type && state.type !== 'product') parts.push(state.type);
  if (state.cat?.length) parts.push(`${state.cat.length} categor${state.cat.length === 1 ? 'y' : 'ies'}`);
  if (state.loc?.length) parts.push(`${state.loc.length} location${state.loc.length === 1 ? '' : 's'}`);
  if (state.warehouseId) parts.push('warehouse');
  if (state.sort) parts.push(`sorted ${state.sort.replace('_', ' ')}`);
  return parts.length === 0 ? 'No filters set' : parts.join(' · ');
}

function SavedViewChip({
  view,
  isActive,
  scope,
  basePath,
  isOwner,
}: {
  view: SavedViewSummary;
  isActive: boolean;
  scope: 'inventory' | 'books';
  basePath: string;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  async function apply() {
    await setActiveWarehouseAction(view.state.warehouseId ?? null);
    const next = new URLSearchParams();
    if (view.state.q) next.set('q', view.state.q);
    if (view.state.status) next.set('status', view.state.status);
    if (view.state.stock) next.set('stock', view.state.stock);
    if (view.state.type) next.set('type', view.state.type);
    if (view.state.sort) next.set('sort', view.state.sort);
    for (const c of view.state.cat ?? []) next.append('cat', c);
    for (const l of view.state.loc ?? []) next.append('loc', l);
    const qs = next.toString();
    router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    router.refresh();
  }

  function remove(e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    setDeleting(true);
    const res = await deleteSavedViewAction(view.id, scope);
    setDeleting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setDeleteOpen(false);
    toast.success(`Saved view "${view.name}" deleted.`);
    router.refresh();
  }

  async function toggleShare(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !view.isShared;
    setSharing(true);
    const res = await toggleSavedViewShareAction(view.id, next, scope);
    setSharing(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(next ? `View "${view.name}" shared with the team.` : `View "${view.name}" set to private.`);
    router.refresh();
  }

  return (
    <span
      className={cn(
        'group inline-flex h-6 items-center gap-1 rounded-full border pl-2 pr-1 text-[11.5px] transition-colors',
        isActive
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
      )}
      title={view.isShared ? `Shared by ${isOwner ? 'you' : 'a teammate'}` : undefined}
    >
      <button
        type="button"
        onClick={apply}
        className="inline-flex items-center gap-1"
        aria-label={`Apply view ${view.name}`}
      >
        {view.isShared ? <Users className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        <span className="max-w-[120px] truncate">{view.name}</span>
      </button>
      {isOwner && (
        <button
          type="button"
          onClick={toggleShare}
          disabled={sharing}
          aria-label={view.isShared ? `Make view ${view.name} private` : `Share view ${view.name} with team`}
          className={cn(
            'ml-0.5 grid h-4 w-4 place-items-center rounded-full opacity-0 transition-opacity hover:bg-foreground/15 group-hover:opacity-100',
            isActive && 'hover:bg-background/20',
          )}
        >
          {sharing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : view.isShared ? (
            <Users className="h-2.5 w-2.5" />
          ) : (
            <Users className="h-2.5 w-2.5 opacity-50" />
          )}
        </button>
      )}
      {isOwner && (
        <button
          type="button"
          onClick={remove}
          disabled={deleting}
          aria-label={`Delete view ${view.name}`}
          className={cn(
            'ml-0.5 grid h-4 w-4 place-items-center rounded-full opacity-0 transition-opacity hover:bg-foreground/15 group-hover:opacity-100',
            isActive && 'hover:bg-background/20',
          )}
        >
          {deleting ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <X className="h-2.5 w-2.5" />}
        </button>
      )}
      <DestructiveConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete saved view "${view.name}"?`}
        description={
          view.isShared
            ? 'This view is shared with the team — every teammate will lose access. The underlying items and filters are not affected; only the saved-view shortcut is removed.'
            : 'The saved-view shortcut will be removed. The underlying items and filters are not affected.'
        }
        confirmLabel="Delete view"
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </span>
  );
}

function SaveCurrentViewButton({
  scope,
  currentState,
}: {
  scope: 'inventory' | 'books';
  currentState: SavedViewSummary['state'];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [shareWithTeam, setShareWithTeam] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setName('');
      setShareWithTeam(false);
    }
  }, [open]);

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    const res = await createSavedViewAction({
      scope,
      name: trimmed,
      state: currentState as Parameters<typeof createSavedViewAction>[0]['state'],
      isShared: shareWithTeam,
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      shareWithTeam ? `View "${trimmed}" saved and shared with the team.` : `View "${trimmed}" saved.`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)] hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> Save view
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3">
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Name
            </label>
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) save();
              }}
              placeholder="Restock candidates"
              maxLength={80}
              className="mt-1 h-8 text-[12.5px]"
            />
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Saving
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--ed-ink-2)]">
              {describeState(currentState)}
            </div>
          </div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareWithTeam}
              onChange={(e) => setShareWithTeam(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
            />
            <div className="flex-1">
              <div className="text-[12px] font-medium">Share with team</div>
              <div className="text-[11px] text-[var(--ed-ink-3)]">
                Everyone in your org will see this view. Only you can edit or
                delete it.
              </div>
            </div>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving || name.trim().length === 0}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SparkModeToggle({
  mode,
  onChange,
}: {
  mode: SparkMode;
  onChange: (m: SparkMode) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const label = mode === 'qty' ? '14-day · qty' : '14-day · moves';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ml-auto inline-flex h-5 items-center gap-1 rounded-sm px-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)] hover:text-foreground"
          aria-label={`Sparkline mode: ${mode === 'qty' ? 'quantity trend' : 'movement count'}`}
        >
          {label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[200px] p-1">
        <div className="flex flex-col">
          {(
            [
              { value: 'qty', label: 'Quantity trend' },
              { value: 'moves', label: 'Move count' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                'rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted',
                opt.value === mode && 'bg-muted font-medium',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
