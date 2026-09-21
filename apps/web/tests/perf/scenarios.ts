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
}

export interface ClickStep {
  /** CSS selector of the link to click; with `hrefPattern`, the first match whose href fits. */
  selector: string;
  hrefPattern?: string;
  arrives: Marker;
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
