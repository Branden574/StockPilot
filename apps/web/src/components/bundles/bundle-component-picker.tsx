'use client';

import { Loader2, Search } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatStockQuantity } from '@stockpilot/core';

/** One search result, as `/api/items/search?rank=relevance` answers it. */
export interface ComponentSearchItem {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  item_type: 'product' | 'book' | 'asset' | 'consumable';
  quantity_on_hand: number;
  awaiting_first_receipt: boolean;
  warehouse_name: string | null;
}

/** Rows one search shows. The rest are counted ("Showing 20 of 143"). */
export const COMPONENT_SEARCH_LIMIT = 20;
/** Quiet time after the last keystroke before a search is sent. */
export const COMPONENT_SEARCH_DEBOUNCE_MS = 200;

/**
 * The request for one search. What may be a bundle component is decided here
 * as parameters the server applies, so the picker never offers an item the
 * kit could not use:
 *
 *   - type=all: books, products, assets and consumables alike (a reading kit
 *     is made of books);
 *   - status=active: not archived or discontinued; deleted items are never
 *     listed (assemble_bundle refuses a deleted component);
 *   - bundles=exclude: never another kit's pre-assembled stock (kits are
 *     built from items, and that stock sits in Staging, where assembly cannot
 *     draw it);
 *   - rental equipment is never listed by this search (the server's rule for
 *     every regular item list);
 *   - expected=any: an item on order but not yet received may still be
 *     planned into a kit, and is marked Expected;
 *   - isbn=1: a book is found by either of its ISBN forms;
 *   - rank=relevance: an exact SKU or barcode first, then the best matches.
 */
export function componentSearchUrl(term: string): string {
  const params = new URLSearchParams({
    q: term,
    rank: 'relevance',
    type: 'all',
    status: 'active',
    bundles: 'exclude',
    expected: 'any',
    isbn: '1',
    limit: String(COMPONENT_SEARCH_LIMIT),
  });
  return `/api/items/search?${params.toString()}`;
}

/** The answer to one search, keyed by the search it answers. */
type SearchOutcome =
  | { term: string; ok: true; items: ComponentSearchItem[]; total: number }
  | { term: string; ok: false };

const ITEM_TYPE_LABEL: Partial<Record<ComponentSearchItem['item_type'], string>> = {
  book: 'Book',
  asset: 'Asset',
  consumable: 'Consumable',
};

/**
 * Search box for adding bundle components: a combobox with a listbox of
 * matches, best match first.
 *
 * One request per settled search (COMPONENT_SEARCH_DEBOUNCE_MS after the last
 * keystroke). A newer keystroke aborts the older request, and an answer is
 * only ever shown for the search it answers, so a slow reply to "pe" can
 * never replace the results for "pencil". While the next answer is on its
 * way the previous rows stay on screen, dimmed and not selectable, so Enter
 * (or a barcode scanner's Enter) cannot add an item from a search that is no
 * longer the one typed.
 *
 * Keyboard: ArrowDown/ArrowUp move, Enter adds the highlighted item, Escape
 * closes the list (a second Escape clears the search). Enter never submits
 * the surrounding bundle form. Items already in the bundle are marked Added
 * and cannot be added again.
 */
export function BundleComponentPicker({
  addedIds,
  onAdd,
}: {
  addedIds: ReadonlySet<string>;
  onAdd: (item: ComponentSearchItem) => void;
}) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<SearchOutcome | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  const optionDomId = (itemId: string) => `${baseId}-option-${itemId}`;

  const term = query.trim();
  const searchable = term.length >= 2;

  React.useEffect(() => {
    if (!searchable) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(componentSearchUrl(term), { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Search failed with status ${res.status}`);
          const body = (await res.json()) as { items?: ComponentSearchItem[]; total?: number };
          if (ctrl.signal.aborted) return;
          const items = Array.isArray(body.items) ? body.items : [];
          setOutcome({
            term,
            ok: true,
            items,
            total: typeof body.total === 'number' ? body.total : items.length,
          });
        })
        .catch(() => {
          // An aborted request belongs to a search that is no longer typed.
          if (ctrl.signal.aborted) return;
          setOutcome({ term, ok: false });
        });
    }, COMPONENT_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [term, searchable, attempt]);

  const current = outcome !== null && outcome.term === term ? outcome : null;
  const searching = searchable && current === null;
  const failed = current !== null && !current.ok;
  const results = current?.ok ? current.items : [];
  // The previous answer, kept on screen (dimmed, inert) while this one loads.
  const staleRows = searching && outcome?.ok ? outcome.items : [];
  const stale = current === null && staleRows.length > 0;
  const rows = current?.ok ? results : stale ? staleRows : [];

  const selectable = stale ? [] : rows.filter((item) => !addedIds.has(item.id));
  const effectiveActiveId =
    activeId !== null && selectable.some((item) => item.id === activeId)
      ? activeId
      : (selectable[0]?.id ?? null);

  const showPopover = open && searchable;

  // Keeps the highlighted row in view as the arrow keys move through a list
  // taller than the popover.
  React.useEffect(() => {
    if (!showPopover || effectiveActiveId === null) return;
    const el = document.getElementById(`${baseId}-option-${effectiveActiveId}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [showPopover, effectiveActiveId, baseId]);

  function add(item: ComponentSearchItem) {
    if (addedIds.has(item.id)) return;
    onAdd(item);
    setQuery('');
    setOpen(false);
    setActiveId(null);
    inputRef.current?.focus();
  }

  function move(step: 1 | -1) {
    if (selectable.length === 0) return;
    const at = selectable.findIndex((item) => item.id === effectiveActiveId);
    const next = selectable[(at + step + selectable.length) % selectable.length];
    if (next) setActiveId(next.id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      case 'Enter': {
        // The search box never submits the bundle form.
        e.preventDefault();
        if (!showPopover || effectiveActiveId === null) return;
        const item = selectable.find((row) => row.id === effectiveActiveId);
        if (item) add(item);
        return;
      }
      case 'Escape': {
        if (showPopover) {
          e.preventDefault();
          setOpen(false);
        } else if (query) {
          e.preventDefault();
          setQuery('');
        }
        return;
      }
      default:
        return;
    }
  }

  function retry() {
    setOutcome(null);
    setAttempt((n) => n + 1);
    inputRef.current?.focus();
  }

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveId(null);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search items by name, SKU, or barcode"
        className="pl-8 pr-8"
        role="combobox"
        aria-label="Search items to add as components"
        aria-autocomplete="list"
        aria-expanded={showPopover}
        aria-controls={listboxId}
        aria-activedescendant={
          showPopover && effectiveActiveId !== null ? optionDomId(effectiveActiveId) : undefined
        }
        autoComplete="off"
        spellCheck={false}
      />
      {searching && (
        <Loader2
          aria-hidden="true"
          className="text-muted-foreground absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin"
        />
      )}

      {showPopover && (
        <div
          className="border-border bg-popover absolute z-10 mt-1 w-full overflow-hidden rounded-md border shadow-lg"
          // Keeps focus in the search box when a row or Try again is clicked.
          onMouseDown={(e) => e.preventDefault()}
        >
          {failed ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <span className="text-destructive">
                Couldn&apos;t search items. Check your connection and try again.
              </span>
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                Try again
              </Button>
            </div>
          ) : current?.ok && results.length === 0 ? (
            <div role="status" className="px-3 py-2.5 text-sm">
              <p>No items match &ldquo;{term}&rdquo;.</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Kits, rental equipment and archived items can&apos;t be components.
              </p>
            </div>
          ) : searching && rows.length === 0 ? (
            <p
              role="status"
              className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm"
            >
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              Searching…
            </p>
          ) : null}

          <ul
            id={listboxId}
            role="listbox"
            aria-label="Matching items"
            aria-busy={searching || undefined}
            className={cn('max-h-72 overflow-y-auto', rows.length === 0 && 'hidden')}
          >
            {rows.map((item) => {
              const added = addedIds.has(item.id);
              const isActive = !stale && item.id === effectiveActiveId;
              const typeLabel = ITEM_TYPE_LABEL[item.item_type];
              return (
                <li
                  key={item.id}
                  id={optionDomId(item.id)}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={added || stale || undefined}
                  onMouseEnter={() => {
                    if (!added && !stale) setActiveId(item.id);
                  }}
                  onClick={() => {
                    if (!stale) add(item);
                  }}
                  className={cn(
                    'border-border/60 flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0',
                    isActive && 'bg-muted',
                    added ? 'cursor-default' : 'cursor-pointer',
                    (added || stale) && 'opacity-60',
                    stale && 'pointer-events-none',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="text-muted-foreground truncate text-[11px]">
                      <span className="font-mono">{item.sku}</span>
                      {item.warehouse_name ? <span> · {item.warehouse_name}</span> : null}
                      {typeLabel ? <span> · {typeLabel}</span> : null}
                      {item.awaiting_first_receipt ? (
                        <span title="On order, not received yet"> · Expected</span>
                      ) : null}
                    </div>
                  </div>
                  {added ? (
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] font-medium">
                      Added
                    </span>
                  ) : (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {formatStockQuantity(item.quantity_on_hand)} on hand
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {current?.ok && current.total > results.length && results.length > 0 ? (
            <p className="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-[11px]">
              Showing {results.length} of {current.total} matches. Keep typing to narrow the list.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
