'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
}

const VIEWS = ['All items', 'Low + critical', 'Out of stock'] as const;
type View = (typeof VIEWS)[number];

function paramsToView(stock: string | null): View {
  if (stock === 'low') return 'Low + critical';
  if (stock === 'out') return 'Out of stock';
  return 'All items';
}

function deriveStatus(qty: number, reorder: number): 'ok' | 'warn' | 'crit' {
  if (qty <= 0) return 'crit';
  if (reorder > 0 && qty <= reorder) return 'warn';
  return 'ok';
}

/**
 * Deterministic synthetic sparkline so empty/new items still render a
 * trend visual. Real movement-derived sparklines hook in once the
 * stock_movements aggregate RPC lands.
 */
function syntheticSeries(seed: string, base: number): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const r = (n: number) => {
    h = (h * 9301 + 49297 + n) % 233280;
    return h / 233280;
  };
  const series: number[] = [];
  let v = base * 0.85;
  for (let i = 0; i < 14; i++) {
    v = Math.max(0, v + (r(i) - 0.5) * Math.max(base, 5) * 0.18);
    series.push(Math.round(v));
  }
  if (series.length > 0) series[series.length - 1] = base;
  return series;
}

export function InventoryTable({
  items,
  lookups,
  total,
  initialQuery = '',
  rowLinkPrefix = '/dashboard/inventory',
  basePath = '/dashboard/inventory',
  showBookFields = false,
}: InventoryTableProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = React.useState(initialQuery);
  const view = paramsToView(params.get('stock'));
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  function hrefForView(v: View): string {
    const next = new URLSearchParams(params.toString());
    if (v === 'Low + critical') next.set('stock', 'low');
    else if (v === 'Out of stock') next.set('stock', 'out');
    else next.delete('stock');
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  React.useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
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
      {/* Saved views */}
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
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] hover:border-[var(--ed-line-strong)]"
        >
          + Saved view
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ed-ink-4)]" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, barcode…"
            className="h-8 pl-8 text-[12.5px]"
            aria-label="Search items"
          />
        </div>
        <p className="ml-auto font-mono text-[11px] tabular-nums text-[var(--ed-ink-3)]">
          {formatNumber(total)} SKUs · {formatCurrency(valueOnHand)} on hand
        </p>
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-foreground/20 bg-card px-3 py-2 text-[12.5px]">
          <span className="font-mono tabular-nums text-[var(--ed-ink-2)]">{selected.size} selected</span>
          <span className="text-[var(--ed-ink-4)]">·</span>
          <Link
            href={`/dashboard/inventory/labels?items=${[...selected].join(',')}`}
            className="text-[var(--ed-ink-2)] hover:text-foreground"
          >
            Print labels
          </Link>
          <span className="text-[var(--ed-ink-4)]">·</span>
          <button className="text-[var(--ed-ink-2)] hover:text-foreground">Adjust stock</button>
          <span className="text-[var(--ed-ink-4)]">·</span>
          <button className="text-[var(--ed-ink-2)] hover:text-foreground">Move</button>
          <span className="text-[var(--ed-ink-4)]">·</span>
          <button className="text-[var(--ed-ink-2)] hover:text-foreground">Tag</button>
          <span className="text-[var(--ed-ink-4)]">·</span>
          <button className="text-destructive hover:underline">Archive</button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-[var(--ed-ink-4)] hover:text-foreground"
          >
            Clear
          </button>
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
                  {label}
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
              const series = syntheticSeries(item.id, item.quantity_on_hand);
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
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.image_url}
                          alt=""
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

      <div className="flex justify-end">
        <Button asChild>
          <Link href="/dashboard/inventory/new">+ New item</Link>
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
