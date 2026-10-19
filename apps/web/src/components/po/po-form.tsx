'use client';

import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { countingUnitLabel, sortBySizeOrder } from '@stockpilot/core';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DetailSection } from '@/components/patterns/detail-section';
import { StatePanel } from '@/components/patterns/state-panel';
import { isbnVariants } from '@/lib/books/isbn-variants';
import { PURCHASE_ORDER_ITEM_TYPES } from '@/lib/purchase-orders/item-types';
import { chunkInFilterValues, IN_FILTER_MAX_VALUES } from '@/lib/supabase/in-filter';
import { cn } from '@/lib/utils';
import { useUnsavedWork } from '@/lib/unsaved-work';
import { formatCurrency } from '@/lib/utils';
import { createPoAction, updatePoAction } from '@/server/actions/purchase-orders';

import type { SizeRunGroup } from './size-run-receive-grid';

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  unit_cost: number;
  /** Sports variant identity (0298). NULL on every item in every non-sports org. */
  groupId?: string | null;
  variantSize?: string | null;
  /**
   * `inventory_items.item_type`. Only ever 'product' or 'book' on a PO
   * (PURCHASE_ORDER_ITEM_TYPES) — drives the "Book" marker on a picker row.
   */
  itemType?: string | null;
  /** For a book this IS the ISBN (barcode = ISBN, as the PO importer matches on). */
  barcode?: string | null;
  /**
   * Set only on rows resolved BY ID for a line that already points at the
   * item (never on a search result): the item was deleted, or it is a kit's
   * pre-assembled stock. Neither can be ordered and the save refuses the
   * line by the item's name, so the line says what it is instead of
   * rendering blank; the buyer removes it.
   */
  deleted?: boolean;
  kitStock?: boolean;
}

// ─── Server-backed item search ─────────────────────────────────────────────
// The picker used to filter a page-level `list({ limit: 1000 })` array in the
// browser, so anything past that cap was unfindable AND unofferable — which is
// also how a whole item TYPE (books) could be missing without the picker ever
// saying so. It now searches server-side through the SHARED
// /api/items/search endpoint (withApiContext-gated, a thin wrapper over
// InventoryService.list, so RLS, warehouse scoping and the archived / deleted /
// rental exclusions all hold exactly as they do on the list pages).

/** Rows a picker shows per query. Small on purpose: this is a line-item
 *  combobox, not a catalog browser. */
const SEARCH_LIMIT = 25;
/** Trailing debounce — collapses a burst of keystrokes into one request. */
const SEARCH_DEBOUNCE_MS = 250;
/** /api/items/search short-circuits below 2 characters (its instant-search
 *  guard); under that we filter the SSR list locally instead. */
const MIN_SERVER_QUERY = 2;

/** The `?slim=1` row shape /api/items/search returns. */
interface SlimSearchRow {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  item_type: string;
  unit_cost: number;
  group_id: string | null;
  variant_size: string | null;
  /** By-id label rows only (`?ids=`): what became of the item. */
  deleted?: boolean;
  is_bundle?: boolean;
}

function toItemOption(r: SlimSearchRow): ItemOption {
  return {
    id: r.id,
    name: r.name,
    sku: r.sku,
    unit_cost: Number(r.unit_cost) || 0,
    groupId: r.group_id,
    variantSize: r.variant_size,
    itemType: r.item_type,
    barcode: r.barcode,
    ...(r.deleted === true ? { deleted: true } : {}),
    ...(r.is_bundle === true ? { kitStock: true } : {}),
  };
}

/** Item-type params shared by both requests below, so search results and
 *  label resolution can never span different types. */
function appendPoItemTypes(p: URLSearchParams): void {
  for (const t of PURCHASE_ORDER_ITEM_TYPES) p.append('type', t);
}

function buildSearchUrl(q: string): string {
  const p = new URLSearchParams();
  p.set('q', q);
  // Text rows only — no thumbnails to sign, no custom_fields blob to ship.
  p.set('slim', '1');
  // ISBN-10 ⇄ ISBN-13 equivalence: a book stocked under one form must be
  // findable by the other.
  p.set('isbn', '1');
  // mig 0277: re-ordering a SKU that is on order but never received has to
  // reuse the existing row instead of inviting a duplicate.
  p.set('expected', 'any');
  p.set('sort', 'name_asc');
  p.set('limit', String(SEARCH_LIMIT));
  // A kit's pre-assembled stock is never ordered (the save refuses it), so
  // the picker never offers it. The by-id resolve below is NOT filtered: an
  // old draft's kit line must still show what it is, so it can be removed.
  p.set('bundles', 'exclude');
  appendPoItemTypes(p);
  return `/api/items/search?${p.toString()}`;
}

function buildResolveByIdsUrl(ids: string[]): string {
  const p = new URLSearchParams();
  for (const id of ids) p.append('ids', id);
  p.set('slim', '1');
  appendPoItemTypes(p);
  return `/api/items/search?${p.toString()}`;
}

/** What a line's label says before the item when the item can no longer be
 *  ordered, so the line the save refuses by name is the one that reads so. */
function lineItemStatePrefix(item: ItemOption): string {
  if (item.deleted) return 'Deleted: ';
  if (item.kitStock) return 'Pre-assembled kit: ';
  return '';
}

/** Digits + a trailing X check character, for ISBN comparison. */
function isbnKey(s: string): string {
  return s.replace(/[^0-9Xx]/g, '').toUpperCase();
}

interface Option {
  id: string;
  name: string;
}

export interface InitialPoValues {
  supplierId: string;
  locationId: string;
  /** Bill-to charter id ('' = none). */
  charterId: string;
  expectedAt: string;
  notes: string;
  poNumber: string;
  lines: Line[];
}

interface PoFormProps {
  items: ItemOption[];
  suppliers: Option[];
  locations: Option[];
  /** Bill-to charter options (rendered on the PO PDF). */
  charters: Option[];
  /** When set, the form is in edit mode for this PO id. */
  poId?: string;
  /** Pre-filled values for edit mode. */
  initial?: InitialPoValues;
  /**
   * Display metadata for the product groups the catalog items belong to,
   * keyed by group id. Empty (the default) for every non-sports org, which
   * hides the "Add size run" mode entirely.
   */
  productGroups?: Record<string, SizeRunGroup>;
  /**
   * Uncapped item rows for the groups in `productGroups`, used ONLY to build
   * the "Add size run" picker's variants (review fix, Task 16). `items` is
   * page-level list()'s capped 1000-row result — in a >1000-item org a
   * group's 1001st+ variant can fall past that cap and never reach `items`,
   * silently under-counting a size run. Falls back to `items` when omitted,
   * so a caller that hasn't wired the uncapped read yet keeps prior (capped)
   * behavior instead of losing the feature outright.
   */
  groupItems?: ItemOption[];
}

/** One orderable size run: a product group and the variants under it. */
interface SizeRunOption {
  groupId: string;
  group: SizeRunGroup;
  /** Already in scale order. */
  variants: ItemOption[];
}

/** A line is either an existing catalog item (itemId set) or a new item to create (newItemName set). */
interface Line {
  /** Set when the user picked an existing catalog item. */
  itemId?: string;
  /** Set when the user typed a free-text name for a new item to create. */
  newItemName?: string;
  quantityOrdered: number;
  unitCost: number;
}

/** Returns true when the line has a valid item selection. */
function lineHasItem(l: Line): boolean {
  return Boolean(l.itemId) || Boolean(l.newItemName?.trim());
}

/** The fields the form edits, as it opened (blank for a new PO). */
type PoFormValues = InitialPoValues;

function initialFormValues(initial: InitialPoValues | undefined): PoFormValues {
  return {
    supplierId: initial?.supplierId ?? '',
    locationId: initial?.locationId ?? '',
    charterId: initial?.charterId ?? '',
    poNumber: initial?.poNumber ?? '',
    expectedAt: initial?.expectedAt ?? '',
    notes: initial?.notes ?? '',
    lines: initial?.lines ?? [],
  };
}

/** One comparable string for the unsaved-work check, in a fixed key order. */
function poFormSnapshot(v: PoFormValues): string {
  return JSON.stringify([
    v.supplierId,
    v.locationId,
    v.charterId,
    v.poNumber,
    v.expectedAt,
    v.notes,
    v.lines.map((l) => [l.itemId ?? null, l.newItemName ?? null, l.quantityOrdered, l.unitCost]),
  ]);
}

// ─── ItemPicker ────────────────────────────────────────────────────────────
// A combobox that lets the user either pick an existing catalog item OR type a
// free-text name to create a new one.  Rendered inline inside each PO line row.

interface ItemPickerProps {
  items: ItemOption[];
  itemId: string | undefined;
  newItemName: string | undefined;
  onPickExisting: (item: ItemOption) => void;
  onPickNew: (name: string) => void;
  /**
   * Extra items consulted ONLY to resolve the currently-selected item's
   * label — never merged into the searchable list. A line added via "Add
   * size run" may point at an item past `items`' page-level cap, and an
   * edit-mode line may point at one no query on this screen returned;
   * without this fallback either renders as unselected even though it has a
   * real itemId. PoForm feeds it the size-run variants plus the rows it
   * resolved by id.
   */
  extraItems?: ItemOption[];
}

function ItemPicker({
  items,
  itemId,
  newItemName,
  onPickExisting,
  onPickNew,
  extraItems,
}: ItemPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  /** Server rows for the CURRENT query; null = none yet for this query. */
  const [results, setResults] = React.useState<ItemOption[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchFailed, setSearchFailed] = React.useState(false);
  /** Monotonic request id. A response whose id is not the latest is dropped,
   *  so a slow early request can never overwrite a newer one's rows. */
  const seqRef = React.useRef(0);

  const trimmedQuery = query.trim();
  const usingServer = trimmedQuery.length >= MIN_SERVER_QUERY;

  // Derive the label shown in the trigger. `extraItems` is a fallback ONLY —
  // it never affects search results below, just this lookup. It carries both
  // the size-run variants and the by-id-resolved rows for lines pointing at
  // an item that no query on this screen happens to have returned.
  const selectedItem =
    items.find((i) => i.id === itemId) ??
    extraItems?.find((i) => i.id === itemId) ??
    results?.find((i) => i.id === itemId) ??
    null;
  const triggerLabel = selectedItem
    ? `${lineItemStatePrefix(selectedItem)}${selectedItem.sku} · ${selectedItem.name}`
    : newItemName
      ? `New: ${newItemName}`
      : null;

  // Debounced server search. AbortController cancels the in-flight request
  // when the query changes or the popover closes; `seqRef` is the second,
  // independent guard against an out-of-order response landing.
  React.useEffect(() => {
    if (!open || !usingServer) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle: drop stale rows the instant the query stops being a server query
      setResults(null);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    // Async fetch lifecycle: mark the rows stale the instant the query
    // changes, so "Create …" cannot be offered against an older answer.
    setSearching(true);
    setSearchFailed(false);
    const seq = ++seqRef.current;
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(buildSearchUrl(trimmedQuery), { signal: ac.signal });
        if (!res.ok) throw new Error(`item search failed (${res.status})`);
        const body = (await res.json()) as { items?: SlimSearchRow[] };
        if (seq !== seqRef.current) return;
        setResults((body.items ?? []).map(toItemOption));
        setSearching(false);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (seq !== seqRef.current) return;
        // Fall back to filtering the server-rendered page list, which is what
        // this picker did before it searched at all — a failed request must
        // degrade, not blank the picker out.
        setResults(null);
        setSearching(false);
        setSearchFailed(true);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [open, usingServer, trimmedQuery]);

  // Local filter over the server-rendered page list. Used for a 0–1 character
  // query (below the endpoint's own floor) and as the degraded fallback when
  // a search request fails.
  const localFiltered = React.useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        (i.barcode ?? '').toLowerCase().includes(q),
    );
  }, [items, trimmedQuery]);

  const visible = React.useMemo(
    () => (usingServer && !searchFailed ? (results ?? []) : localFiltered),
    [usingServer, searchFailed, results, localFiltered],
  );
  /** True while the rows on screen do not yet answer the typed query. */
  const pending = usingServer && searching && !searchFailed;

  // "Create '<typed>'" suppression. Comparing only against the local array by
  // NAME (the old rule) would offer to mint a duplicate for any item that
  // exists but did not happen to be on the page — under server paging that is
  // every off-page book. The typed query now suppresses create when it EXACTLY
  // matches an existing name, SKU, barcode or ISBN in the result set for that
  // query, and create is never offered while results are still pending.
  const exactExisting = React.useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return false;
    // [] for anything that is not a 10/13-character ISBN, so a word query
    // gets no ISBN treatment at all.
    const variants = new Set(isbnVariants(trimmedQuery));
    return visible.some((i) => {
      if (i.name.toLowerCase() === q) return true;
      if (i.sku.toLowerCase() === q) return true;
      const bc = (i.barcode ?? '').trim();
      if (!bc) return false;
      if (bc.toLowerCase() === q) return true;
      return variants.size > 0 && variants.has(isbnKey(bc));
    });
  }, [visible, trimmedQuery]);

  const showCreate =
    trimmedQuery.length > 0 && trimmedQuery.length <= 200 && !pending && !exactExisting;

  function handlePickExisting(item: ItemOption) {
    onPickExisting(item);
    setQuery('');
    setOpen(false);
  }

  function handlePickNew() {
    onPickNew(trimmedQuery);
    setQuery('');
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Drawn as the form's own fields (the shared Input's box): 32 px on a
          desktop, 44 px on a phone, the stronger hairline and the app's focus
          ring. Its accessible name stays its own words (the picked item's
          "SKU · name", "New: …" or the placeholder), which the tests and a
          screen reader read. */}
      <PopoverTrigger
        type="button"
        className={cn(
          'bg-card border-line-strong flex h-8 w-full min-w-0 items-center gap-2 rounded-md border px-2.5 text-left text-[13px] outline-none transition-colors max-sm:h-11',
          'hover:bg-muted focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2',
          'data-[state=open]:border-foreground/40',
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {triggerLabel ? (
            <span className={newItemName ? 'text-muted-foreground italic' : 'text-foreground'}>
              {triggerLabel}
            </span>
          ) : (
            <span className="text-muted-foreground">Pick or create an item…</span>
          )}
        </span>
        <ChevronsUpDown aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      </PopoverTrigger>

      <PopoverContent className="w-[min(480px,calc(100vw-1rem))] p-0" align="start" sideOffset={4}>
        <Command shouldFilter={false} className="bg-popover overflow-hidden rounded-lg">
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <Search aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search by name, SKU, barcode or ISBN, or type a new item name…"
              // 16 px below sm so iOS does not zoom into the field (the shared
              // Input's phone rule).
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] outline-none max-sm:text-base"
            />
            {pending && (
              <Loader2
                aria-label="Searching"
                className="text-muted-foreground h-3.5 w-3.5 shrink-0 animate-spin"
              />
            )}
          </div>
          <Command.List className="max-h-[280px] overflow-y-auto p-1.5">
            {searchFailed && (
              <p className="text-warning px-2 py-1.5 text-[12px]">
                Search is unavailable — showing items from this page only.
              </p>
            )}
            {showCreate && (
              <Command.Item
                value={`__create__${trimmedQuery}`}
                onSelect={handlePickNew}
                className={ROW}
              >
                <Plus aria-hidden className="text-accent mr-2 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0">
                  Create <span className="font-medium">"{trimmedQuery}"</span>
                  <span className="text-muted-foreground ml-1.5 text-[12px]">as a new item</span>
                </span>
              </Command.Item>
            )}
            {pending && visible.length === 0 && (
              <p className="text-muted-foreground py-6 text-center text-[13px]">Searching…</p>
            )}
            {!pending && visible.length === 0 && !showCreate && (
              <Command.Empty className="text-muted-foreground py-6 text-center text-[13px]">
                No matches. Type a name to create a new item.
              </Command.Empty>
            )}
            {visible.map((i) => {
              const isActive = i.id === itemId;
              const isBook = i.itemType === 'book';
              return (
                <Command.Item
                  key={i.id}
                  value={`${i.sku} ${i.name}`}
                  onSelect={() => handlePickExisting(i)}
                  className={ROW}
                >
                  {isActive ? (
                    <Check aria-hidden className="mr-2 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="mr-2 inline-block h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="text-muted-foreground mr-2 shrink-0 font-mono text-[11.5px]">
                    {i.sku}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  {/* Books are first-class PO lines, so a row says which it is
                      and shows the ISBN it was matched on. Same row, same
                      height — muted trailing metadata, no new component. */}
                  {isBook && (
                    <span className="border-line-strong text-muted-foreground ml-2 shrink-0 rounded-full border px-1.5 text-[11px] leading-4">
                      Book
                    </span>
                  )}
                  {isBook && i.barcode && (
                    <span className="text-muted-foreground ml-1.5 shrink-0 font-mono text-[11.5px]">
                      {i.barcode}
                    </span>
                  )}
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Menu rows at the redesign's 13 px with the neutral highlight (DESIGN-SPEC
// 6.21 popover rows), at least 32 px tall and 44 px on a phone.
const ROW = cn(
  'flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] outline-none max-sm:min-h-11',
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
);

/**
 * The line editor's columns. On a desktop one row per line: the item takes the
 * room, then Qty, Unit cost, Subtotal and the remove button (the PO page's
 * line rows, DESIGN-SPEC 6.18). On a phone a line stacks: the item on its own
 * row, then Qty, Unit cost and Subtotal side by side, then the remove button,
 * so every field stays in view without a page-wide scroll.
 */
const LINE_GRID =
  'grid grid-cols-3 items-end gap-x-3 gap-y-2 px-4 sm:grid-cols-[minmax(0,1fr)_88px_112px_104px_32px] sm:items-start';

/** A line field's label: shown over the field on a phone, read aloud everywhere.
 *  A block, so every label starts at its column's top and the four labels of a
 *  stacked line sit on one row (an inline label rode 3 px lower than a block
 *  one in the line box). */
const LINE_LABEL = 'text-muted-foreground block text-[12px] font-normal leading-4 sm:sr-only';

// ─── PoForm ─────────────────────────────────────────────────────────────────

/**
 * "Add size run": pick a product group, enter a quantity per size, and get one
 * PO line per variant in a single action — instead of hunting the same shoe
 * through the item picker nine times.
 *
 * Every line it emits is an ordinary line pointed at an ordinary
 * `inventory_items` row, because a variant IS an item. Nothing about the PO
 * payload, the receipt RPC, or the ledger changes.
 */
function SizeRunAddDialog({
  open,
  onOpenChange,
  runs,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  runs: SizeRunOption[];
  onAdd: (picked: Array<{ item: ItemOption; quantity: number }>) => void;
}) {
  const [groupId, setGroupId] = React.useState<string>(runs[0]?.groupId ?? '');
  const [quantities, setQuantities] = React.useState<Record<string, number>>({});

  // The reset below needs the CURRENT runs but must not re-run when their
  // identity changes — so it reads them through a ref instead of a dep. The
  // ref is synced in its own effect (never during render) and is declared
  // FIRST, so on the commit that opens the dialog it lands before the reset
  // effect below reads it.
  const runsRef = React.useRef(runs);
  React.useEffect(() => {
    runsRef.current = runs;
  });

  // Reset on every OPEN so a previous run's quantities can never leak into the
  // next one and silently order stock nobody asked for.
  //
  // Deps are `[open]` ALONE, deliberately. They used to include `runs`, and
  // that blanked live input: `runs` is the parent's `sizeRuns` useMemo over
  // [groupItems, items, productGroups], and all three of those props are
  // rebuilt fresh by the Server Component on every render. The PO routes sit
  // inside the org-wide InventoryRealtime nudge, so a colleague receiving a
  // PO or moving stock fires router.refresh() -> new prop identities -> new
  // `runs` array -> this effect fired while the dialog was still OPEN and
  // wiped every per-size quantity the buyer had typed (and snapped the group
  // select back to runs[0]). Same class as the receive dialog's [open, lines]
  // reset. A re-derived array that is value-identical is not a reason to
  // discard user input; only re-opening the dialog is.
  React.useEffect(() => {
    if (!open) return;
    setGroupId(runsRef.current[0]?.groupId ?? '');
    setQuantities({});
  }, [open]);

  const run = runs.find((r) => r.groupId === groupId) ?? null;
  const totalQty = run
    ? run.variants.reduce((s, v) => s + Math.max(0, quantities[v.id] ?? 0), 0)
    : 0;
  const sizeCount = run ? run.variants.filter((v) => (quantities[v.id] ?? 0) > 0).length : 0;

  function confirm() {
    if (!run) return;
    const picked = run.variants
      .map((item) => ({ item, quantity: Math.max(0, quantities[item.id] ?? 0) }))
      .filter((p) => p.quantity > 0);
    if (picked.length === 0) return;
    onAdd(picked);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a size run</DialogTitle>
          <DialogDescription>
            Pick a product group and enter how many of each size to order. Each size becomes its own
            line, so receiving stays per-size.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="po-size-run-group">Product group</Label>
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger id="po-size-run-group">
              <SelectValue placeholder="Choose a product group" />
            </SelectTrigger>
            <SelectContent>
              {runs.map((r) => (
                <SelectItem key={r.groupId} value={r.groupId}>
                  {r.group.name} ({r.variants.length} sizes)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {run && (
          // One row per size in scale order (size, SKU, quantity), as rows of
          // a list card: the size reads first, the SKU in mono, the quantity
          // field at the right edge, and every row keeps its own field.
          <div className="border-border bg-card divide-border max-h-[45vh] divide-y overflow-y-auto rounded-lg border">
            {run.variants.map((v) => (
              <div
                key={v.id}
                className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(88px,120px)] items-center gap-3 px-4 py-2"
              >
                <div className="text-foreground truncate text-[13.5px] font-medium tabular-nums">
                  {v.variantSize?.trim() ? v.variantSize : 'No size'}
                </div>
                <div className="text-muted-foreground truncate font-mono text-[12px]">{v.sku}</div>
                <div>
                  <BlankZeroNumberInput
                    min={0}
                    step={1}
                    aria-label={`Quantity for size ${v.variantSize ?? v.sku}`}
                    value={quantities[v.id] ?? 0}
                    onValueChange={(n) => setQuantities((m) => ({ ...m, [v.id]: Math.max(0, n) }))}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="items-center justify-between gap-3 sm:justify-between">
          <span className="text-muted-foreground text-[12.5px] tabular-nums">
            {sizeCount === 0
              ? 'Nothing entered yet.'
              : `Ordering ${totalQty} ${countingUnitLabel(
                  run?.group.countingUnit ?? 'each',
                  totalQty,
                )} across ${sizeCount} ${sizeCount === 1 ? 'size' : 'sizes'}`}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={confirm} disabled={sizeCount === 0}>
              Add {sizeCount || ''} {sizeCount === 1 ? 'line' : 'lines'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PoForm({
  items,
  suppliers,
  locations,
  charters,
  poId,
  initial,
  productGroups = {},
  groupItems,
}: PoFormProps) {
  const router = useRouter();
  const [supplierId, setSupplierId] = React.useState<string>(initial?.supplierId ?? '');
  const [locationId, setLocationId] = React.useState<string>(initial?.locationId ?? '');
  const [charterId, setCharterId] = React.useState<string>(initial?.charterId ?? '');
  const [poNumber, setPoNumber] = React.useState<string>(initial?.poNumber ?? '');
  const [expectedAt, setExpectedAt] = React.useState<string>(initial?.expectedAt ?? '');
  const [notes, setNotes] = React.useState<string>(initial?.notes ?? '');
  const [lines, setLines] = React.useState<Line[]>(initial?.lines ?? []);
  const [submitting, setSubmitting] = React.useState(false);

  const total = lines.reduce((s, l) => s + l.quantityOrdered * l.unitCost, 0);

  // ── Unsaved work (CONFLICTS D30) ─────────────────────────────────────────
  // The one global "Refresh to update" reload asks before it discards a form
  // that registered here (lib/unsaved-work.ts). Dirty = anything differs from
  // what the form opened with (blank for a new PO, the stored PO for an edit),
  // or a save is in flight. After a successful save the form is clean while
  // the router moves on to the PO's page.
  const [openedWith] = React.useState(() => poFormSnapshot(initialFormValues(initial)));
  const savedRef = React.useRef(false);
  // useUnsavedWork keeps the LATEST function, read at the moment of the
  // click, so this closure always sees the current fields.
  useUnsavedWork(
    poId ? `po-form-${poId}` : 'po-form-new',
    poId ? `Editing ${initial?.poNumber || 'purchase order'}` : 'New purchase order',
    () => {
      if (savedRef.current) return false;
      if (submitting) return true;
      return (
        poFormSnapshot({
          supplierId,
          locationId,
          charterId,
          poNumber,
          expectedAt,
          notes,
          lines,
        }) !== openedWith
      );
    },
  );

  const [sizeRunOpen, setSizeRunOpen] = React.useState(false);

  // ── Selected-line label resolution ───────────────────────────────────────
  // A line's item does NOT have to be in the page-level list: an edit-mode
  // draft can point at an item past the 1000-row cap, at one archived since
  // the PO was written, or (before this change) at a type the page never
  // fetched at all. Any of those rendered the line blank — it looked
  // unselected while still carrying a real itemId. Resolve the missing ids
  // by ID through the same shared endpoint and feed them to the picker as
  // extra label sources.
  const knownById = React.useMemo(() => {
    const m = new Map<string, ItemOption>();
    for (const i of items) m.set(i.id, i);
    for (const i of groupItems ?? []) if (!m.has(i.id)) m.set(i.id, i);
    return m;
  }, [items, groupItems]);

  const selectedItemIds = React.useMemo(
    () => Array.from(new Set(lines.map((l) => l.itemId).filter((v): v is string => Boolean(v)))),
    [lines],
  );

  const [resolvedById, setResolvedById] = React.useState<Record<string, ItemOption>>({});
  // Ids already requested, so editing a quantity (which re-runs the effect via
  // `lines`) can never re-fire the same fetch. A ref, not state, because it
  // must not itself trigger a render.
  const requestedIdsRef = React.useRef<Set<string>>(new Set());
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    const missing = selectedItemIds.filter(
      (id) => !knownById.has(id) && !requestedIdsRef.current.has(id),
    );
    if (missing.length === 0) return;
    for (const id of missing) requestedIdsRef.current.add(id);
    // Deliberately NOT aborted on cleanup: this effect re-runs on every line
    // edit, and aborting would cancel a resolution whose ids are already
    // marked requested — leaving that label permanently blank. `mountedRef`
    // is what stops the state write after unmount.
    // The endpoint takes at most IN_FILTER_MAX_VALUES ids per request (the
    // same constant it slices with, so the two cannot drift apart); chunk so
    // a large size run (or a long pasted draft) still resolves every line.
    for (const chunk of chunkInFilterValues(missing, { maxValues: IN_FILTER_MAX_VALUES })) {
      void (async () => {
        try {
          const res = await fetch(buildResolveByIdsUrl(chunk));
          if (!res.ok) throw new Error(`item resolve failed (${res.status})`);
          const body = (await res.json()) as { items?: SlimSearchRow[] };
          if (!mountedRef.current) return;
          const next: Record<string, ItemOption> = {};
          for (const r of body.items ?? []) next[r.id] = toItemOption(r);
          if (Object.keys(next).length === 0) return;
          setResolvedById((prev) => ({ ...prev, ...next }));
        } catch {
          // Un-mark so a later render retries; leaving them marked would
          // freeze the label blank for the rest of the session.
          for (const id of chunk) requestedIdsRef.current.delete(id);
        }
      })();
    }
  }, [selectedItemIds, knownById]);

  /**
   * Remember an item the user just picked out of a SEARCH RESULT. Those rows
   * live in the picker's per-query state, which is dropped the moment the
   * query is cleared — without this the line would go blank the instant it
   * was filled in, and the by-id effect would fire a pointless request to
   * re-fetch a row we are already holding.
   */
  const rememberItem = React.useCallback((item: ItemOption) => {
    requestedIdsRef.current.add(item.id);
    setResolvedById((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: item }));
  }, []);

  /** Label-only sources for the picker: size-run variants, by-id resolutions
   *  and anything picked out of a search result. Never merged into the
   *  searchable result set. */
  const pickerExtraItems = React.useMemo(
    () => [...(groupItems ?? []), ...Object.values(resolvedById)],
    [groupItems, resolvedById],
  );

  // The orderable size runs: product groups this org's catalog actually has
  // two or more variants for. A one-variant group is not a run and offering it
  // here would just be a slower item picker.
  //
  // Sourced from `groupItems` (the uncapped, group-scoped read), NOT `items`
  // (page-level list()'s capped 1000-row result) — review fix, Task 16. Using
  // `items` here silently under-counted a size run for any group whose
  // 1001st+ variant fell past the cap. Falls back to `items` only when the
  // caller has not wired the uncapped read at all.
  const sizeRuns = React.useMemo<SizeRunOption[]>(() => {
    const source = groupItems ?? items;
    const byGroup = new Map<string, ItemOption[]>();
    for (const i of source) {
      if (!i.groupId || !productGroups[i.groupId]) continue;
      const arr = byGroup.get(i.groupId);
      if (arr) arr.push(i);
      else byGroup.set(i.groupId, [i]);
    }
    const out: SizeRunOption[] = [];
    for (const [groupId, variants] of byGroup) {
      if (variants.length < 2) continue;
      const group = productGroups[groupId];
      if (!group) continue;
      out.push({
        groupId,
        group,
        variants: sortBySizeOrder(variants, (v) => v.variantSize, group.sizeOrder),
      });
    }
    return out.sort((a, b) => a.group.name.localeCompare(b.group.name));
  }, [groupItems, items, productGroups]);

  function addLine() {
    setLines((prev) => [...prev, { quantityOrdered: 1, unitCost: 0 }]);
  }

  /**
   * Fold a picked size run into the line list.
   *
   * A variant already on the PO has its quantity INCREASED rather than
   * gaining a second line: two lines for one size would show up as two rows
   * of the same size in the receive grid, and a receiver would have no way to
   * tell which one to fill.
   */
  function addSizeRun(picked: Array<{ item: ItemOption; quantity: number }>) {
    // Merge computed against the CURRENT `lines` (read once here, not via a
    // functional setLines updater) so the toast below is a plain side effect
    // that runs exactly once — the previous version fired it INSIDE the
    // updater, which React's Strict Mode double-invokes to catch impurities
    // like this, doubling the toast in dev.
    const next = [...lines];
    let added = 0;
    for (const { item, quantity } of picked) {
      const existing = next.findIndex((l) => l.itemId === item.id);
      if (existing >= 0) {
        const current = next[existing];
        if (!current) continue;
        next[existing] = {
          ...current,
          quantityOrdered: current.quantityOrdered + quantity,
        };
        continue;
      }
      next.push({ itemId: item.id, quantityOrdered: quantity, unitCost: item.unit_cost });
      added += 1;
    }
    const merged = picked.length - added;
    setLines(next);
    toast.success(
      merged > 0
        ? `Added ${added} line${added === 1 ? '' : 's'}; topped up ${merged} already on this PO.`
        : `Added ${added} line${added === 1 ? '' : 's'}.`,
    );
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (lines.length === 0) {
      toast.error('Add at least one line item to the purchase order.');
      return;
    }
    if (lines.some((l) => !lineHasItem(l) || l.quantityOrdered <= 0)) {
      toast.error('Every line needs an item and a positive quantity.');
      return;
    }
    setSubmitting(true);
    const trimmedPoNumber = poNumber.trim();
    const payload = {
      supplierId: supplierId || null,
      destinationLocationId: locationId || null,
      charterId: charterId || null,
      expectedAt: expectedAt ? new Date(expectedAt).toISOString() : null,
      notes: notes || undefined,
      // Only include poNumber when non-empty; omitting it lets the service
      // auto-generate via next_po_number().
      ...(trimmedPoNumber ? { poNumber: trimmedPoNumber } : {}),
      lines: lines.map((l) =>
        l.itemId
          ? { itemId: l.itemId, quantityOrdered: l.quantityOrdered, unitCost: l.unitCost }
          : {
              newItemName: l.newItemName!.trim(),
              quantityOrdered: l.quantityOrdered,
              unitCost: l.unitCost,
            },
      ),
    };

    if (poId) {
      // Edit mode
      const res = await updatePoAction(poId, payload);
      setSubmitting(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      savedRef.current = true;
      toast.success('Purchase order updated.');
      router.push(`/dashboard/purchase-orders/${poId}`);
    } else {
      // Create mode
      const res = await createPoAction(payload);
      setSubmitting(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      savedRef.current = true;
      toast.success('Purchase order created.');
      router.push(`/dashboard/purchase-orders/${res.data.id}`);
    }
  }

  // Field ids: unique per mounted form, so each label names its own control.
  const fid = React.useId();
  const fieldId = (name: string) => `${fid}-${name}`;
  const optional = <span className="text-muted-foreground font-normal">(optional)</span>;

  // One card, "PO details", as before (DESIGN-SPEC 6.7): the header fields in
  // two columns (one on a phone), the line editor drawn as the PO page's
  // line rows (6.18), the notes, then the footer the PO page's line card
  // has: the Total on the left and the form's two buttons on the right.
  return (
    <DetailSection
      title="PO details"
      footer={
        <>
          {lines.length > 0 ? (
            <p className="text-[13.5px]">
              <span className="text-muted-foreground">Total: </span>
              <span className="text-foreground ml-1.5 font-mono font-medium tabular-nums">
                {formatCurrency(total)}
              </span>
            </p>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => router.back()} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="gradient" onClick={submit} disabled={submitting || lines.length === 0}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : poId ? (
                'Save changes'
              ) : (
                'Create PO'
              )}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={fieldId('supplier')}>Supplier {optional}</Label>
            <Select
              value={supplierId || '__none'}
              onValueChange={(v: string) => setSupplierId(v === '__none' ? '' : v)}
            >
              <SelectTrigger id={fieldId('supplier')}>
                <SelectValue placeholder="No supplier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No supplier</SelectItem>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={fieldId('location')}>Destination location {optional}</Label>
            <Select
              value={locationId || '__none'}
              onValueChange={(v: string) => setLocationId(v === '__none' ? '' : v)}
            >
              <SelectTrigger id={fieldId('location')}>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={fieldId('number')}>PO number {optional}</Label>
            <Input
              id={fieldId('number')}
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              placeholder="Auto-generated if left blank"
              maxLength={64}
              className="font-mono"
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={fieldId('expected')}>Expected delivery {optional}</Label>
            <Input
              id={fieldId('expected')}
              type="date"
              value={expectedAt}
              onChange={(e) => setExpectedAt(e.target.value)}
            />
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={fieldId('charter')}>Bill to charter {optional}</Label>
            <Select
              value={charterId || '__none'}
              onValueChange={(v: string) => setCharterId(v === '__none' ? '' : v)}
            >
              <SelectTrigger id={fieldId('charter')}>
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

        <div
          role="group"
          aria-labelledby={fieldId('lines')}
          className="flex min-w-0 flex-col gap-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span id={fieldId('lines')} className="text-foreground text-[13px] font-medium">
              Line items
            </span>
            <div className="flex flex-wrap gap-2">
              {sizeRuns.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSizeRunOpen(true)}
                >
                  <Plus className="h-4 w-4" /> Add size run
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-4 w-4" /> Add line
              </Button>
            </div>
          </div>
          {sizeRuns.length > 0 && (
            <SizeRunAddDialog
              open={sizeRunOpen}
              onOpenChange={setSizeRunOpen}
              runs={sizeRuns}
              onAdd={addSizeRun}
            />
          )}
          <div className="border-border min-w-0 overflow-hidden rounded-lg border">
            {lines.length === 0 ? (
              <StatePanel
                kind="empty"
                surface="plain"
                icon={null}
                headingLevel={null}
                title={'No lines yet. Click "Add line" to start.'}
                className="p-6"
              />
            ) : (
              <>
                {/* Column heads (DESIGN-SPEC 6.9) on a desktop. Each row also
                    names its own fields for assistive technology and, on a
                    phone where the row stacks, on screen. */}
                <div
                  aria-hidden
                  className={cn(
                    LINE_GRID,
                    'bg-sunk border-border text-muted-foreground hidden border-b py-2 text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.06em] sm:grid',
                  )}
                >
                  <span>Item</span>
                  <span>Qty</span>
                  <span>Unit cost</span>
                  <span className="text-right">Subtotal</span>
                  <span />
                </div>
                <ul className="divide-border divide-y">
                  {lines.map((line, idx) => {
                    const qtyId = fieldId(`line-${idx}-qty`);
                    const costId = fieldId(`line-${idx}-cost`);
                    return (
                      <li key={idx} className={cn(LINE_GRID, 'py-3')}>
                        <div className="col-span-3 min-w-0 space-y-1 sm:col-span-1">
                          <span className={LINE_LABEL}>Item</span>
                          <ItemPicker
                            items={items}
                            itemId={line.itemId}
                            newItemName={line.newItemName}
                            extraItems={pickerExtraItems}
                            onPickExisting={(item) => {
                              rememberItem(item);
                              updateLine(idx, {
                                itemId: item.id,
                                newItemName: undefined,
                                unitCost: item.unit_cost,
                              });
                            }}
                            onPickNew={(name) =>
                              updateLine(idx, {
                                itemId: undefined,
                                newItemName: name,
                              })
                            }
                          />
                          {line.newItemName && (
                            <p className="text-muted-foreground text-[12px]">
                              A new catalog item will be created when you save this PO.
                            </p>
                          )}
                        </div>
                        <div className="min-w-0 space-y-1">
                          <Label htmlFor={qtyId} className={LINE_LABEL}>
                            Qty
                          </Label>
                          <BlankZeroNumberInput
                            id={qtyId}
                            min={1}
                            step={1}
                            value={line.quantityOrdered}
                            onValueChange={(n) => updateLine(idx, { quantityOrdered: n })}
                            placeholder="Qty"
                            className="tabular-nums"
                          />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <Label htmlFor={costId} className={LINE_LABEL}>
                            Unit cost
                          </Label>
                          <BlankZeroNumberInput
                            id={costId}
                            min={0}
                            step={0.01}
                            value={line.unitCost}
                            onValueChange={(n) => updateLine(idx, { unitCost: n })}
                            placeholder="0.00"
                            className="tabular-nums"
                          />
                        </div>
                        <div className="min-w-0 space-y-1">
                          <span className={cn(LINE_LABEL, 'text-right')}>Subtotal</span>
                          <p className="text-foreground flex h-8 items-center justify-end font-mono text-[13px] tabular-nums max-sm:h-11">
                            {formatCurrency(line.quantityOrdered * line.unitCost)}
                          </p>
                        </div>
                        <div className="col-span-3 flex justify-end sm:col-span-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove line ${idx + 1}`}
                            onClick={() => removeLine(idx)}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={fieldId('notes')}>Notes {optional}</Label>
          <Textarea
            id={fieldId('notes')}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>
    </DetailSection>
  );
}
