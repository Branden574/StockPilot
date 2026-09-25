'use client';

import { Loader2, Search } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ItemMatchTier } from '@/lib/inventory/rank-item-matches';
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
  /** Why the server ranked it where it did. 'exact': its SKU or barcode IS
   *  the search, which is what a scanned code is. */
  match: ItemMatchTier;
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

/** The answer to one search, keyed by the search it answers. `status` is the
 *  HTTP status of a failed answer, or null when no answer came back at all. */
type SearchOutcome =
  | { term: string; ok: true; items: ComponentSearchItem[]; total: number }
  | { term: string; ok: false; status: number | null };

const ITEM_TYPE_LABEL: Partial<Record<ComponentSearchItem['item_type'], string>> = {
  book: 'Book',
  asset: 'Asset',
  consumable: 'Consumable',
};

/** What a failed search says, by what failed. */
function failureMessage(status: number | null): string {
  // /api/items/search answers 401 when the session is gone; trying again
  // cannot help, signing in again can.
  if (status === 401) return 'Your session has ended. Refresh the page to sign in again.';
  if (status === null) return "Couldn't reach the server. Check your connection and try again.";
  return "Search didn't work. Try again.";
}

/** What the live region says when an answer lists rows. */
function resultsAnnouncement(shown: number, total: number): string {
  const count =
    total > shown ? `${shown} of ${total} items` : shown === 1 ? '1 item' : `${shown} items`;
  return `${count}. Use the up and down arrows to choose, Enter to add.`;
}

/**
 * Search box for adding bundle components: a combobox with a listbox of
 * matches, best match first.
 *
 * One request per settled search (COMPONENT_SEARCH_DEBOUNCE_MS after the last
 * keystroke). A newer keystroke aborts the older request, and an answer is
 * only ever shown for the search it answers, so a slow reply to "pe" can
 * never replace the results for "pencil". While the next answer is on its
 * way the previous rows stay on screen, dimmed and not selectable, so Enter
 * cannot add an item from a search that is no longer the one typed.
 *
 * An Enter pressed before its search is answered (a barcode scanner types the
 * code and Enter within milliseconds) is kept for that search: when the answer
 * has exactly one exact SKU or barcode match, that item is added; otherwise
 * the answer is left to choose from and the search text is selected, so the
 * next scan replaces it instead of being appended to it.
 *
 * Keyboard: ArrowDown/ArrowUp move, Enter adds the highlighted item, Escape
 * closes the list (a second Escape clears the search). Enter never submits
 * the surrounding bundle form. The pointer highlights a row only when it
 * moves, so a list scrolled by the arrow keys under a still mouse keeps the
 * row the keys reached. Items already in the bundle are marked Added and
 * cannot be added again.
 *
 * Screen readers hear one always-present polite live region: the result
 * count, "No items match", and "Added <name>." after an add. A failure is an
 * alert.
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
  /** The item just added, for the live region, until the next keystroke. */
  const [lastAdded, setLastAdded] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** The search an Enter was pressed for before its answer arrived. */
  const pendingEnterRef = React.useRef<string | null>(null);
  /** Where the pointer was last seen over the rows (screen coordinates). */
  const pointerAtRef = React.useRef<{ x: number; y: number } | null>(null);
  /** The pointer made the latest highlight change, so the list must not scroll. */
  const highlightByPointerRef = React.useRef(false);
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  const optionDomId = (itemId: string) => `${baseId}-option-${itemId}`;

  const term = query.trim();
  const searchable = term.length >= 2;

  // The answer to one search, and the Enter that may be waiting for it. An
  // Effect Event, so it sees this render's addedIds and onAdd rather than
  // those of the render that sent the request.
  const onAnswer = React.useEffectEvent((answer: SearchOutcome) => {
    setOutcome(answer);
    if (pendingEnterRef.current !== answer.term) return;
    pendingEnterRef.current = null;
    const exact = answer.ok ? answer.items.filter((item) => item.match === 'exact') : [];
    // One exact match is the item the code names. Two (one SKU in two
    // warehouses) is a choice the person has to make.
    const only = exact.length === 1 ? exact[0] : undefined;
    if (only && !addedIds.has(only.id)) {
      add(only);
      return;
    }
    inputRef.current?.select();
  });

  React.useEffect(() => {
    if (!searchable) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(componentSearchUrl(term), { signal: ctrl.signal })
        .then(async (res): Promise<SearchOutcome> => {
          if (!res.ok) return { term, ok: false, status: res.status };
          const body = (await res.json().catch(() => null)) as {
            items?: ComponentSearchItem[];
            total?: number;
          } | null;
          if (body === null) return { term, ok: false, status: res.status };
          const items = Array.isArray(body.items) ? body.items : [];
          return {
            term,
            ok: true,
            items,
            total: typeof body.total === 'number' ? body.total : items.length,
          };
        })
        .catch((): SearchOutcome => ({ term, ok: false, status: null }))
        .then((answer) => {
          // An aborted request belongs to a search that is no longer typed.
          if (!ctrl.signal.aborted) onAnswer(answer);
        });
    }, COMPONENT_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [term, searchable, attempt]);

  const current = outcome !== null && outcome.term === term ? outcome : null;
  const searching = searchable && current === null;
  const failure = current !== null && !current.ok ? current : null;
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
  // taller than the popover, and brings a new answer's first row into view.
  // Not when the pointer moved the highlight: that row is under the pointer
  // already, and scrolling would slide another row under it.
  React.useEffect(() => {
    if (!showPopover || effectiveActiveId === null) return;
    if (highlightByPointerRef.current) {
      highlightByPointerRef.current = false;
      return;
    }
    const el = document.getElementById(`${baseId}-option-${effectiveActiveId}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [showPopover, effectiveActiveId, baseId]);

  function add(item: ComponentSearchItem) {
    if (addedIds.has(item.id)) return;
    onAdd(item);
    setLastAdded(item.name);
    setQuery('');
    setOpen(false);
    setActiveId(null);
    pendingEnterRef.current = null;
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
        if (!showPopover) return;
        if (current === null) {
          // This search has no answer yet (the rows on screen, if any, are the
          // previous search's). Keep the Enter for it; onAnswer decides.
          pendingEnterRef.current = term;
          return;
        }
        if (effectiveActiveId === null) return;
        const item = selectable.find((row) => row.id === effectiveActiveId);
        if (item) add(item);
        return;
      }
      case 'Escape': {
        pendingEnterRef.current = null;
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

  // One polite live region, always in the page: a region mounted together
  // with its text is often not read (VoiceOver especially). The failure is
  // announced by its own alert, so it adds nothing here.
  let announcement = '';
  if (showPopover) {
    if (current === null) announcement = 'Searching…';
    else if (current.ok) {
      announcement =
        current.items.length === 0
          ? `No items match “${term}”.`
          : resultsAnnouncement(current.items.length, current.total);
    }
  } else if (!query && lastAdded !== null) {
    announcement = `Added ${lastAdded}.`;
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
          setLastAdded(null);
          pendingEnterRef.current = null;
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
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {showPopover && (
        <div
          className="border-border bg-popover absolute z-10 mt-1 w-full overflow-hidden rounded-md border shadow-lg"
          // Keeps focus in the search box when a row or Try again is clicked.
          onMouseDown={(e) => e.preventDefault()}
        >
          {failure ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <span className="text-destructive">{failureMessage(failure.status)}</span>
              {failure.status !== 401 ? (
                <Button type="button" variant="outline" size="sm" onClick={retry}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : current?.ok && results.length === 0 ? (
            <div className="px-3 py-2.5 text-sm">
              <p>No items match &ldquo;{term}&rdquo;.</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Kits, rental equipment, and archived or discontinued items aren&apos;t listed
                here.
              </p>
            </div>
          ) : searching && rows.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm">
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
                  onMouseEnter={(e) => {
                    // Entering a row only notes where the pointer is. When the
                    // arrow keys scroll the list under a still pointer, the
                    // browser reports the row now under it; taking the
                    // highlight then made Enter add that row instead.
                    pointerAtRef.current = { x: e.screenX, y: e.screenY };
                  }}
                  onMouseMove={(e) => {
                    const at = pointerAtRef.current;
                    // Some browsers also send a move, at the same spot, after
                    // a scroll. Only a pointer that moved takes the highlight.
                    if (at !== null && at.x === e.screenX && at.y === e.screenY) return;
                    pointerAtRef.current = { x: e.screenX, y: e.screenY };
                    if (added || stale || item.id === effectiveActiveId) return;
                    highlightByPointerRef.current = true;
                    setActiveId(item.id);
                  }}
                  onClick={() => {
                    if (!stale) add(item);
                  }}
                  className={cn(
                    'border-border/60 flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0',
                    // The row Enter adds: a bar in the accent ink as well as
                    // the tint, since the muted tint alone is about 1.1:1
                    // against the popover in either theme.
                    isActive && 'bg-muted shadow-[inset_3px_0_0_hsl(var(--accent-foreground))]',
                    added ? 'cursor-default' : 'cursor-pointer',
                    (added || stale) && 'opacity-60',
                    stale && 'pointer-events-none',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {/* Two lines, then the full name on hover: editions often
                        differ only at the end of the title. */}
                    <div className="line-clamp-2 break-words font-medium" title={item.name}>
                      {item.name}
                    </div>
                    <div className="text-muted-foreground flex flex-wrap gap-x-1 text-[11px]">
                      <span className="break-all font-mono">{item.sku}</span>
                      {item.warehouse_name ? <span>· {item.warehouse_name}</span> : null}
                      {typeLabel ? <span>· {typeLabel}</span> : null}
                      {item.awaiting_first_receipt ? (
                        <span title="On order, not received yet">· Expected</span>
                      ) : null}
                    </div>
                  </div>
                  {added ? (
                    <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium">
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
