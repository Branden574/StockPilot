'use client';

import { Loader2, X } from 'lucide-react';
import * as React from 'react';

import { BigChart } from '@/components/dashboard/big-chart';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import { Card, CardHead } from './shared';

/**
 * Interactive island for the dashboard "Inventory value" card (Unit C).
 *
 * SSR-FIRST: the card is seeded with the server's default 30-day / cost /
 * all-locations `initialSeries` (already computed by the dashboard loader) and
 * renders it with ZERO fetches on mount — the default view is identical to the
 * old static card and does not touch the load-perf fan-out. Every deviation
 * (basis toggle, location filter, Compare menu) fetches ON DEMAND from
 * GET /api/dashboard/value-series (Unit A), and returning to the exact default
 * restores the SSR seed rather than re-fetching it.
 *
 * The endpoint (Unit A) has no dedicated single-line mode, so the PRIMARY line
 * for a non-default (basis, location) is sourced from `mode=previous` and its
 * "Current period" line — exactly the current window for that basis + warehouse.
 * That same fetch backs the "Previous period" comparison, so the two share a
 * cache entry. Comparisons overlay via BigChart's multi-series `series` prop
 * (Unit B) with the primary line first so it keeps the accent colour + legend.
 */

type Basis = 'cost' | 'retail';
type CompareMode = 'previous' | 'locations' | 'retail_vs_cost';

interface Warehouse {
  id: string;
  name: string;
}

interface SeedPoint {
  value: number;
  label: string;
}

/** One labelled line as returned by the Unit A endpoint (`data` = number[]). */
interface FetchedSeries {
  label: string;
  data: number[];
}

/** Response shape of GET /api/dashboard/value-series (Unit A `ValueComparison`). */
interface ValueSeriesResponse {
  mode: CompareMode;
  days: number;
  basis: Basis;
  series: FetchedSeries[];
}

interface ChartPoint {
  value: number;
  label?: string;
}

interface ValueChartInteractiveProps {
  /** Server-rendered default line (cost / 30d / the topbar's warehouse). */
  initialSeries: SeedPoint[];
  /** Org warehouses for the location filter — already fetched by the page. */
  warehouses: Warehouse[];
  /** Topbar warehouse filter the seed was computed for (null = all locations). */
  initialWarehouseId: string | null;
  /** Applied to the outer Card so the page grid keeps `lg:col-span-9`. */
  className?: string;
}

const DAYS = 30;

const COMPARE_OPTIONS: Array<{ mode: CompareMode; label: string }> = [
  { mode: 'previous', label: 'Previous period' },
  { mode: 'locations', label: 'By location' },
  { mode: 'retail_vs_cost', label: 'Cost vs retail' },
];

const COMPARE_LABEL: Record<CompareMode, string> = {
  previous: 'Previous period',
  locations: 'By location',
  retail_vs_cost: 'Cost vs retail',
};

function buildUrl(mode: CompareMode, basis: Basis, warehouseId: string | null): string {
  const sp = new URLSearchParams({ mode, basis, days: String(DAYS) });
  if (warehouseId) sp.set('warehouseId', warehouseId);
  return `/api/dashboard/value-series?${sp.toString()}`;
}

/** Label of the line that should render FIRST (accent) for a given mode/basis. */
function primaryLabelFor(mode: CompareMode, basis: Basis): string | null {
  if (mode === 'previous') return 'Current period';
  if (mode === 'retail_vs_cost') return basis === 'retail' ? 'Retail (approx.)' : 'Cost';
  return null; // 'locations' — no single primary, keep the loader's order
}

/** Move the primary line to index 0 so BigChart paints it in the accent hue. */
function orderForDisplay(mode: CompareMode, basis: Basis, series: FetchedSeries[]): FetchedSeries[] {
  const label = primaryLabelFor(mode, basis);
  if (!label) return series;
  const i = series.findIndex((s) => s.label === label);
  if (i <= 0) return series;
  return [series[i]!, ...series.slice(0, i), ...series.slice(i + 1)];
}

/** number[] → BigChart ChartPoint[]. */
function toPoints(data: number[]): ChartPoint[] {
  return data.map((value) => ({ value }));
}

/** Pull the current-window line out of a `mode=previous` response. */
function currentPeriodPoints(res: ValueSeriesResponse): ChartPoint[] {
  const cur =
    res.series.find((s) => s.label === 'Current period') ?? res.series[res.series.length - 1];
  return toPoints(cur?.data ?? []);
}

export function ValueChartInteractive({
  initialSeries,
  warehouses,
  initialWarehouseId,
  className,
}: ValueChartInteractiveProps) {
  const initialPoints = React.useMemo<ChartPoint[]>(
    () => initialSeries.map((p) => ({ value: p.value, label: p.label })),
    [initialSeries],
  );

  const [basis, setBasis] = React.useState<Basis>('cost');
  const [warehouseId, setWarehouseId] = React.useState<string | null>(initialWarehouseId);
  const [compareMode, setCompareMode] = React.useState<CompareMode | null>(null);

  // Fetched, on-demand results. `single` is the last fetched primary line tagged
  // with the request URL it came from; `compare` the last fetched overlay. The
  // DEFAULT (cost · seed warehouse · no comparison) view is NOT stored here — it
  // is derived straight from the SSR seed below, so mount writes no state and
  // fires no fetch.
  const [single, setSingle] = React.useState<{ key: string; points: ChartPoint[] } | null>(null);
  const [compare, setCompare] = React.useState<ValueSeriesResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Session cache keyed by request URL — re-selecting a (mode,basis,days,wh)
  // combination is instant and issues no second fetch.
  const cacheRef = React.useRef<Map<string, ValueSeriesResponse>>(new Map());

  const isDefault =
    compareMode === null && basis === 'cost' && warehouseId === initialWarehouseId;

  React.useEffect(() => {
    // DEFAULT view renders from the SSR seed (derived below) — nothing to fetch
    // and no synchronous state writes, so dashboard mount stays fetch-free.
    if (isDefault) return;

    let cancelled = false;
    const controller = new AbortController();
    const mode: CompareMode = compareMode ?? 'previous';
    const url = buildUrl(mode, basis, warehouseId);
    const cache = cacheRef.current;

    void (async () => {
      // Kept inside the async body (not the effect body) so it is not a
      // synchronous setState-in-effect; still runs before the awaited fetch so
      // the spinner shows immediately.
      setLoading(true);
      setError(null);
      try {
        let res = cache.get(url);
        if (!res) {
          const r = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          if (!r.ok) throw new Error(`value-series ${r.status}`);
          res = (await r.json()) as ValueSeriesResponse;
          cache.set(url, res);
        }
        if (cancelled) return;
        if (compareMode === null) {
          setSingle({ key: url, points: currentPeriodPoints(res) });
        } else {
          setCompare(res);
        }
      } catch (err) {
        if (cancelled || (err as { name?: string })?.name === 'AbortError') return;
        setError('Couldn’t load this view. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [basis, warehouseId, compareMode, initialWarehouseId, isDefault]);

  // Derived single line: the SSR seed unless a fetched primary matches the
  // current (basis, warehouse). Returning to the default therefore always shows
  // the seed without re-fetching, and a stale fetch for a different selection is
  // ignored (its key won't match).
  const singleUrl = buildUrl('previous', basis, warehouseId);
  const singlePoints = single && single.key === singleUrl ? single.points : initialPoints;

  // Show the overlay only once THIS mode's data has arrived (guards against a
  // stale response from a previously-selected mode flashing in).
  const showCompare = compareMode !== null && compare !== null && compare.mode === compareMode;
  const chartSeries = showCompare
    ? orderForDisplay(compareMode, basis, compare.series).map((s) => ({
        label: s.label,
        data: toPoints(s.data),
      }))
    : null;

  // Loading/error belong to the on-demand fetch lifecycle; the seed view (default)
  // never surfaces either.
  const displayLoading = !isDefault && loading;
  const displayError = isDefault ? null : error;

  const locationName = warehouseId
    ? (warehouses.find((w) => w.id === warehouseId)?.name ?? 'Selected location')
    : 'All locations';
  const subtitleLocation = warehouseId ? locationName : 'all locations';
  const basisLabel = basis === 'retail' ? 'retail basis (approx.)' : 'cost basis';
  const subtitle = `USD · ${basisLabel} · ${subtitleLocation}`;

  const controls = (
    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
      {/* Location filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-[11.5px]">
            {locationName}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          <DropdownMenuItem
            onSelect={() => setWarehouseId(null)}
            className={cn(warehouseId === null && 'font-semibold')}
          >
            All locations
          </DropdownMenuItem>
          {warehouses.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => setWarehouseId(w.id)}
              className={cn(warehouseId === w.id && 'font-semibold')}
            >
              {w.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Basis toggle (segmented). Retail is flagged approximate. */}
      <div
        role="group"
        aria-label="Value basis"
        className="border-border inline-flex h-7 items-center overflow-hidden rounded-full border"
      >
        {(['cost', 'retail'] as Basis[]).map((b) => (
          <button
            key={b}
            type="button"
            aria-pressed={basis === b}
            title={
              b === 'retail'
                ? 'Approximate — retail price held constant across past days'
                : undefined
            }
            onClick={() => setBasis(b)}
            className={cn(
              'h-full px-2.5 text-[11.5px] transition-colors',
              basis === b
                ? 'bg-background text-foreground font-medium'
                : 'text-[var(--ed-ink-3)] hover:text-foreground',
            )}
          >
            {b === 'retail' ? 'Retail' : 'Cost'}
          </button>
        ))}
      </div>

      {/* Compare menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-7 px-2.5 text-[11.5px]',
              compareMode ? 'border-solid' : 'border-dashed text-[var(--ed-ink-3)]',
            )}
          >
            {compareMode ? COMPARE_LABEL[compareMode] : '+ Compare'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {COMPARE_OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.mode}
              onSelect={() => setCompareMode(o.mode)}
              className={cn(compareMode === o.mode && 'font-semibold')}
            >
              {o.label}
            </DropdownMenuItem>
          ))}
          {compareMode && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCompareMode(null)}>
                Clear comparison
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {compareMode && (
        <button
          type="button"
          aria-label="Clear comparison"
          onClick={() => setCompareMode(null)}
          className="border-border text-[var(--ed-ink-3)] hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-full border"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {displayLoading && (
        <Loader2
          aria-label="Loading"
          role="status"
          className="h-3.5 w-3.5 animate-spin text-[var(--ed-ink-3)]"
        />
      )}
    </div>
  );

  return (
    <Card className={className}>
      <CardHead title="Inventory value · 30 days" subtitle={subtitle} action={controls} />
      {chartSeries ? (
        <BigChart series={chartSeries} height={300} />
      ) : (
        <BigChart data={singlePoints} height={300} />
      )}
      {displayError ? (
        <div className="px-5 pb-3.5 pt-1 text-[12px] text-[hsl(var(--destructive))]" role="alert">
          {displayError}
        </div>
      ) : (
        <div className="flex justify-between px-5 pb-3.5 font-mono text-[11px] text-[var(--ed-ink-4)]">
          <span>30 days ago</span>
          <span>3 weeks ago</span>
          <span>2 weeks ago</span>
          <span>1 week ago</span>
          <span>Today</span>
        </div>
      )}
    </Card>
  );
}
