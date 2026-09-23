/**
 * What the harness measures. One entry = one row of the owner's before/after
 * table. Every marker below was checked against the rendered DOM: the loading
 * skeletons (components/dashboard/skeletons.tsx) contain no <table>, no <h1> and
 * no detail link, so none of these can fire on a skeleton.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Every dashboard loading.tsx is built from these pulsing bars (components/dashboard/skeletons.tsx). */
const DASHBOARD_SKELETON = 'main .animate-pulse.bg-muted';

/**
 * The two "I heard you" elements: NavLinkPending's spinner, and NavProgressBar
 * while it is CLIMBING. The climbing state is matched on purpose: the bar's
 * wrapper can outlive a navigation (it lingers in its faded-out "complete"
 * state), and a leftover wrapper must not be read as feedback for the next click.
 */
export const FEEDBACK_SELECTORS = [
  'aside a svg.animate-spin',
  'div[aria-hidden="true"].pointer-events-none.fixed.inset-x-0.top-0 > div[class*="nav-progress-climb"]',
];

/**
 * The dashboard error boundary (app/(dashboard)/error.tsx): a warning icon next
 * to a heading. It has an <h1> too, so a heading marker alone would record a
 * crashed page as a fast success.
 */
export const ERROR_SCREEN = 'svg.text-destructive + div > h1';

export interface Marker {
  /** Regex source for the pathname. */
  path: string;
  selector: string;
  /** This route's loading skeleton, to time "click -> loading shell". */
  shell?: string;
  /** When set, `selector` must match a link whose href fits this regex source. */
  hrefPattern?: string;
  /** Regex source the query string must also match (?tab=, ?page=, ?sort=). */
  search?: string;
  /** Only a node that was not on the page when the step was armed counts (a change within one page). */
  freshOnly?: boolean;
  /** The marker's table row must contain this text (a search result). */
  rowText?: string;
  /** Useful = this element's text changed from its value when armed (a saved number on screen). */
  changedText?: string;
}

export interface ClickStep {
  /** CSS selector of the link to click; with `hrefPattern`, the first match whose href fits. */
  selector: string;
  hrefPattern?: string;
  arrives: Marker;
  /**
   * How the step is made. `click` (default); `back` / `forward` (the browser's
   * history buttons, `selector` unused); `fill` (types `text` into `selector`
   * in one input event).
   */
  via?: 'click' | 'back' | 'forward' | 'fill';
  text?: string;
  /** Unmeasured clicks first, e.g. opening the menu the measured click picks from. */
  setup?: string[];
}

export interface Scenario {
  id: string;
  /** The label used in the report table. */
  title: string;
  kind: 'soft-navigation' | 'hard-load';
  start: string;
  /** Proof the start page has real content before anything is timed. */
  startReady: Marker;
  /** Clicks made (and awaited) before the measured one: used to model a revisit. */
  prelude?: ClickStep[];
  /** The measured click. Absent on a hard load, where `startReady` is the finish line. */
  click?: ClickStep;
  /**
   * Measure the photos inside `scope` once the content is up. `first` is how many
   * count as "the first ones": table rows where the photos sit in a table,
   * otherwise the first N photos on screen in document order (a card grid).
   */
  photos?: { scope: string; first: number; settledWhenGone?: string };
  /** A fresh browser profile per iteration: empty HTTP cache, the true first visit. */
  coldBrowserCache?: boolean;
  /** Overrides PERF_HOVER_MS for this scenario. 0 = the pointer lands and clicks at once. */
  hoverMs?: number;
  /** Overrides PERF_SETTLE_MS. 0 = click as soon as the start page shows content (quick click). */
  settleMs?: number;
  /** Rest after the prelude, before the measured step (the revisit after the router cache expired). */
  restBeforeMs?: number;
  /** Overrides PERF_ITERATIONS: for scenarios that take minutes per sample. The report shows n. */
  iterations?: number;
}

const INVENTORY_ROWS: Marker = {
  path: '^/dashboard/inventory$',
  shell: DASHBOARD_SKELETON,
  selector: 'main table tbody tr a[href]',
  // Row links carry `?return=…`, so the id may be followed by a query.
  hrefPattern: `^/dashboard/inventory/${UUID}(\\?|$)`,
};
const ORDER_ROWS: Marker = {
  path: '^/dashboard/orders$',
  shell: DASHBOARD_SKELETON,
  selector: 'main a[href]',
  hrefPattern: `^/dashboard/orders/${UUID}(\\?|$)`,
};
// The overview's greeting is the only <h1> with the display face.
const OVERVIEW: Marker = { path: '^/dashboard$', selector: 'main h1.font-display' };
const ITEM_DETAIL: Marker = {
  path: `^/dashboard/inventory/${UUID}$`,
  // The item name sits in the detail page's sticky header.
  selector: 'main div.sticky h1',
  shell: DASHBOARD_SKELETON,
};
const ORDER_DETAIL: Marker = {
  path: `^/dashboard/orders/${UUID}$`,
  selector: 'main h1',
  shell: DASHBOARD_SKELETON,
};
const BOOK_ROWS: Marker = {
  path: '^/dashboard/books$',
  selector: 'main table tbody tr a[href]',
  hrefPattern: `^/dashboard/(books|inventory)/${UUID}(\\?|$)`,
  shell: DASHBOARD_SKELETON,
};

// "First" = the rows the list marks as priority (inventory-table.tsx: first 12),
// and the same count of cards on the storefront.
const LIST_PHOTOS = { scope: 'main', first: 12 };
// The storefront fills in strips after its first card; its photo set is only
// final once no skeleton block is left.
const STOREFRONT_PHOTOS = { scope: 'main', first: 12, settledWhenGone: '.sf-sk' };

// Real storefront cards. The catalog skeleton is built from `.sf-sk` blocks and
// contains none of these.
const STOREFRONT: Marker = {
  path: '^/dashboard/orders/new$',
  selector: '.sf-card, .sf-row, .sf-feat-card',
  shell: '.sf-sk',
};

// Inventory rows that were NOT on the page before the step: the list after a
// change within the page (next page, sort, filter, search). The query-string
// check keeps a half-applied change from counting.
const inventoryRowsWhere = (search?: string, rowText?: string): Marker => ({
  ...INVENTORY_ROWS,
  ...(search ? { search } : {}),
  ...(rowText ? { rowText } : {}),
  freshOnly: true,
});
// The item page's tab panel. It is rendered on the server WITH its data (no
// client fetch, no inner skeleton), so its presence is the tab's real content,
// a filled feed or its empty state.
const itemTab = (tab: 'movements' | 'activity'): Marker => ({
  path: ITEM_DETAIL.path,
  search: `(^|[?&])tab=${tab}(&|$)`,
  selector: `#item-detail-panel-${tab}`,
});
// The Overview panel's on-hand number (item-detail.tsx, DetailRow "On hand").
const ON_HAND = '#item-detail-panel-overview span.text-base.font-semibold.tabular-nums';
const OPEN_FIRST_ITEM: ClickStep = {
  selector: 'main table tbody tr a[href]',
  hrefPattern: INVENTORY_ROWS.hrefPattern,
  arrives: ITEM_DETAIL,
};

export const SCENARIOS: Scenario[] = [
  {
    id: 'dashboard-to-inventory',
    title: 'Dashboard → Inventory',
    kind: 'soft-navigation',
    start: '/dashboard',
    startReady: OVERVIEW,
    click: { selector: 'aside a[href="/dashboard/inventory"]', arrives: INVENTORY_ROWS },
    photos: LIST_PHOTOS,
  },
  {
    id: 'dashboard-to-orders',
    title: 'Dashboard → Orders',
    kind: 'soft-navigation',
    start: '/dashboard',
    startReady: OVERVIEW,
    click: { selector: 'aside a[href="/dashboard/orders"]', arrives: ORDER_ROWS },
  },
  {
    id: 'inventory-to-item',
    title: 'Inventory → Item',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    click: {
      selector: 'main table tbody tr a[href]',
      hrefPattern: INVENTORY_ROWS.hrefPattern,
      arrives: ITEM_DETAIL,
    },
    // The detail tier: one photo, so it shows up in the delivery audit.
    photos: { scope: 'main', first: 1 },
  },
  {
    // The navigation the Orders list's per-row prefetches exist to speed up.
    // Measured so that removing those prefetches is judged on what it costs.
    id: 'orders-to-order',
    title: 'Orders → Order',
    kind: 'soft-navigation',
    start: '/dashboard/orders',
    startReady: ORDER_ROWS,
    click: { selector: 'main a[href]', hrefPattern: ORDER_ROWS.hrefPattern, arrives: ORDER_DETAIL },
  },
  {
    id: 'dashboard-to-books',
    title: 'Dashboard → Books',
    kind: 'soft-navigation',
    start: '/dashboard',
    startReady: OVERVIEW,
    click: { selector: 'aside a[href="/dashboard/books"]', arrives: BOOK_ROWS },
    photos: LIST_PHOTOS,
  },
  {
    // Back to a list visited seconds ago: what the 90s client router cache is for.
    id: 'inventory-revisit',
    title: 'Inventory revisit (within 90s)',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [{ selector: 'aside a[href="/dashboard"]', arrives: OVERVIEW }],
    click: { selector: 'aside a[href="/dashboard/inventory"]', arrives: INVENTORY_ROWS },
  },
  {
    // The owner's cold soft-navigation budget, and the only soft navigation
    // whose photos are NOT already in the browser cache.
    id: 'dashboard-to-inventory-cold-browser',
    title: 'Dashboard → Inventory (empty browser cache)',
    kind: 'soft-navigation',
    start: '/dashboard',
    startReady: OVERVIEW,
    click: { selector: 'aside a[href="/dashboard/inventory"]', arrives: INVENTORY_ROWS },
    photos: LIST_PHOTOS,
    coldBrowserCache: true,
  },
  {
    // The card grid: masters through the image optimizer, where the photo
    // regression lives (the Items list serves small static thumbnails).
    id: 'orders-to-storefront',
    title: 'Orders → New order (storefront)',
    kind: 'soft-navigation',
    start: '/dashboard/orders',
    startReady: { path: '^/dashboard/orders$', selector: 'main h1' },
    click: { selector: 'main a[href="/dashboard/orders/new"]', arrives: STOREFRONT },
    photos: STOREFRONT_PHOTOS,
  },
  {
    // The owner's 10 s report (2026-09-22). A tab is a query-only navigation.
    id: 'item-movements-tab',
    title: 'Item → Movements tab',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [OPEN_FIRST_ITEM],
    click: { selector: '#item-detail-tab-movements', arrives: itemTab('movements') },
  },
  {
    id: 'item-activity-tab',
    title: 'Item → Activity tab',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [OPEN_FIRST_ITEM],
    click: { selector: '#item-detail-tab-activity', arrives: itemTab('activity') },
  },
  {
    // The browser's Back button, from an item to the list it was opened from.
    id: 'back-item-to-inventory',
    title: 'Back: Item → Inventory',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [OPEN_FIRST_ITEM],
    click: { selector: '', via: 'back', arrives: INVENTORY_ROWS },
  },
  {
    id: 'forward-inventory-to-item',
    title: 'Forward: Inventory → Item',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [OPEN_FIRST_ITEM, { selector: '', via: 'back', arrives: INVENTORY_ROWS }],
    click: { selector: '', via: 'forward', arrives: ITEM_DETAIL },
  },
  {
    id: 'inventory-next-page',
    title: 'Inventory → next page',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    click: {
      selector: 'main a:has-text("Next →")',
      arrives: inventoryRowsWhere('(^|[?&])page=2(&|$)'),
    },
  },
  {
    id: 'inventory-search',
    title: 'Inventory search (typed)',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    click: {
      selector: 'main input[aria-label="Search items"]',
      via: 'fill',
      text: 'deluxe',
      arrives: inventoryRowsWhere(undefined, 'deluxe'),
    },
  },
  {
    id: 'inventory-sort',
    title: 'Inventory sort (Name Z → A)',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    click: {
      setup: ['main button[aria-label^="Sort by"]'],
      selector: 'button:has-text("Name (Z → A)")',
      arrives: inventoryRowsWhere('(^|[?&])sort=name_desc(&|$)'),
    },
  },
  {
    id: 'inventory-filter',
    title: 'Inventory filter (first category)',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    click: {
      setup: ['main button[aria-label="Filter by Category"]'],
      // The popover (Radix: role=dialog) the setup click opened.
      selector: '[role="dialog"] button[role="checkbox"]',
      // Not the URL: the filter control applies at once and writes the URL
      // after a 300 ms debounce (use-instant-filters.ts), so the rows are the
      // user's answer.
      arrives: inventoryRowsWhere(),
    },
  },
  {
    // LAB ONLY: writes. A +1 adjustment on the first item, timed from Apply to
    // the NEW on-hand number on screen: time to confirmed freshness after a
    // save. Its requests row counts the renders a save costs.
    id: 'item-adjust-save',
    title: 'Item: adjust stock, Apply → new on-hand shown',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [OPEN_FIRST_ITEM],
    click: {
      setup: ['main button:has-text("Adjust stock")'],
      selector: '[role="dialog"] button:has-text("Apply")',
      arrives: {
        path: ITEM_DETAIL.path,
        selector: ON_HAND,
        changedText: ON_HAND,
      },
    },
  },
  {
    // No hover warning at all: the pointer lands on the link and clicks.
    id: 'dashboard-to-inventory-no-hover',
    title: 'Dashboard → Inventory, no hover',
    kind: 'soft-navigation',
    start: '/dashboard',
    startReady: OVERVIEW,
    hoverMs: 0,
    click: { selector: 'aside a[href="/dashboard/inventory"]', arrives: INVENTORY_ROWS },
  },
  {
    // Clicked the moment the dashboard shows content, before its own
    // warm-ups and late chunks are done.
    id: 'dashboard-to-inventory-quick',
    title: 'Dashboard → Inventory, quick click after load',
    kind: 'soft-navigation',
    start: '/dashboard',
    startReady: OVERVIEW,
    settleMs: 0,
    click: { selector: 'aside a[href="/dashboard/inventory"]', arrives: INVENTORY_ROWS },
  },
  {
    // After the 90 s client router cache has expired: a real server trip.
    id: 'inventory-revisit-after-90s',
    title: 'Inventory revisit after 95 s',
    kind: 'soft-navigation',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    prelude: [{ selector: 'aside a[href="/dashboard"]', arrives: OVERVIEW }],
    restBeforeMs: 95_000,
    iterations: 8,
    click: { selector: 'aside a[href="/dashboard/inventory"]', arrives: INVENTORY_ROWS },
  },
  {
    id: 'hard-load-inventory',
    title: 'Hard-load Inventory',
    kind: 'hard-load',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    photos: LIST_PHOTOS,
  },
  {
    id: 'hard-load-storefront',
    title: 'Hard-load storefront',
    kind: 'hard-load',
    start: '/dashboard/orders/new',
    startReady: STOREFRONT,
    photos: STOREFRONT_PHOTOS,
  },
  {
    id: 'hard-load-inventory-cold-browser',
    title: 'Hard-load Inventory (empty browser cache)',
    kind: 'hard-load',
    start: '/dashboard/inventory',
    startReady: INVENTORY_ROWS,
    photos: LIST_PHOTOS,
    coldBrowserCache: true,
  },
  {
    id: 'hard-load-storefront-cold-browser',
    title: 'Hard-load storefront (empty browser cache)',
    kind: 'hard-load',
    start: '/dashboard/orders/new',
    startReady: STOREFRONT,
    photos: STOREFRONT_PHOTOS,
    coldBrowserCache: true,
  },
];
