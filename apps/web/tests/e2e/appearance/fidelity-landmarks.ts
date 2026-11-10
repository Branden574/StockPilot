/**
 * Plan 8.1-1 and 8.1-2: the landmarks a drawn board and the app page are
 * compared by, and the comparison itself. Pure (no Playwright at run time),
 * so src/test/stage5-fidelity-landmarks.test.ts proves the rules; the lab
 * spec fidelity-geometry.spec.ts measures the app, and
 * liquid-glass/verify/stage5/export-board-landmarks.mjs measures the boards
 * (reference-shots/_render) into fixtures/board-landmarks.json with the same
 * definitions (it reads the "board" selectors below from the JSON's own copy,
 * so the two can never drift: the spec checks the copy equals this file).
 *
 * Rules (plan 8.1-1): position within 2 px and size within 1 px for a fixed
 * landmark (sidebar, top bar, page header, toolbar, table header cells,
 * cards, selection bar, pager; an open dialog needs a click on the board, so it
 * is a recorded gap); a landmark whose size follows the data
 * (a card holding rows) is held to its position and width only.
 * Style (8.1-2): computed font family (first family), size, weight, line
 * height, letter spacing; opaque colours within delta E 2000 of 1; radii;
 * backdrop-filter; box shadow; border widths. Exact, except the gaps the plan
 * names as unavoidable (KNOWN_STYLE_GAPS), which are reported, not failed.
 */

import { deltaE00Rgb, parseCssColor } from './a11y-math';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The computed style properties 8.1-2 compares, as getComputedStyle gives them. */
export const STYLE_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'color',
  'backgroundColor',
  'borderTopLeftRadius',
  'borderTopWidth',
  'borderBottomWidth',
  'boxShadow',
  'backdropFilter',
] as const;
export type StyleProp = (typeof STYLE_PROPS)[number];
export type StyleRecord = Partial<Record<StyleProp, string>>;

export interface Measured extends Box {
  style?: StyleRecord;
}

export interface LandmarkDef {
  name: string;
  /** CSS selector in the board's DOM (open shadow roots are searched too). */
  board: string;
  /** CSS selector in the app's DOM. */
  app: string;
  /** Fixed: size held to 1 px. Otherwise only x, y and width are compared. */
  fixed: boolean;
}

/** Shell landmarks every signed-in board draws. */
const SHELL: LandmarkDef[] = [
  { name: 'sidebar', board: 'aside', app: '[data-glass="sidebar"]', fixed: true },
  { name: 'topbar', board: 'header.topbar', app: '[data-glass="topbar"]', fixed: true },
  { name: 'h1', board: 'main h1', app: 'main h1', fixed: false },
];
const PAGE_HEADER: LandmarkDef = {
  name: 'page-header',
  board: '.page-h',
  app: '[data-glass="page-header"]',
  fixed: false,
};
const TOOLBAR: LandmarkDef = {
  name: 'toolbar',
  board: '.toolbar',
  app: '[data-glass="items-toolbar"], [data-glass="filter-bar"]',
  fixed: true,
};
const FIRST_COLUMN_HEADER: LandmarkDef = {
  name: 'column-header-1',
  board: '[role="columnheader"]',
  app: '[role="columnheader"]',
  fixed: true,
};
const FIRST_CARD: LandmarkDef = {
  name: 'card-1',
  board: '.card',
  app: '[data-glass="card"]',
  fixed: false,
};
const PAGER: LandmarkDef = {
  name: 'pager',
  board: '.pager',
  app: '[data-glass="pager"], [data-glass="items-pager"], [data-glass="orders-pager"]',
  fixed: true,
};
const SELBAR: LandmarkDef = {
  name: 'selection-bar',
  board: '.selbar',
  app: '[data-glass="selbar"], [data-glass="order-items-selbar"]',
  fixed: true,
};

/** How the app reaches the record a detail board draws. */
export type RouteSpec =
  | { kind: 'path'; path: string }
  /** Open the list, then the first record link matching `link` inside main. */
  | { kind: 'first'; list: string; link: string };

export interface BoardTarget {
  /** shots.json "screen". */
  board: string;
  route: RouteSpec;
  /** 'signed-in' boards need a session; 'signed-out' run in an empty context. */
  auth: 'signed-in' | 'signed-out';
  landmarks: LandmarkDef[];
  /** A board state the spec makes before measuring (default: none). */
  state?: 'selection';
  /**
   * The board variants compared (shots.json "variant"). Default: the exact
   * structural references, reduced and contrast. A board drawn only in its
   * default (scene) variant is compared for geometry only.
   */
  variants?: readonly string[];
}

/** The variants a target is compared in. */
export const variantsOf = (t: BoardTarget): readonly string[] => t.variants ?? EXACT_VARIANTS;

/** Every drawn web board at its board size (shots.json page "app", "auth", "web"). */
export const BOARD_TARGETS: BoardTarget[] = [
  {
    board: 'Overview',
    route: { kind: 'path', path: '/dashboard' },
    auth: 'signed-in',
    variants: ['default'],
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Items',
    route: { kind: 'path', path: '/dashboard/inventory' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, TOOLBAR, FIRST_COLUMN_HEADER, FIRST_CARD, PAGER],
  },
  {
    board: 'Items',
    route: { kind: 'path', path: '/dashboard/inventory' },
    auth: 'signed-in',
    state: 'selection',
    landmarks: [SELBAR],
  },
  {
    board: 'Books',
    route: { kind: 'path', path: '/dashboard/books' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, TOOLBAR, FIRST_COLUMN_HEADER, FIRST_CARD],
  },
  {
    board: 'Item-Detail',
    route: {
      kind: 'first',
      list: '/dashboard/inventory',
      link: 'tbody a[href^="/dashboard/inventory/"]',
    },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Book-Detail',
    route: { kind: 'first', list: '/dashboard/books', link: 'tbody a[href^="/dashboard/"]' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Orders',
    route: { kind: 'path', path: '/dashboard/orders' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_COLUMN_HEADER, FIRST_CARD, PAGER],
  },
  {
    board: 'Order-New',
    route: { kind: 'path', path: '/dashboard/orders/new' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Order-Detail',
    route: { kind: 'first', list: '/dashboard/orders', link: 'a[href^="/dashboard/orders/"]' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Manage-Items',
    route: { kind: 'path', path: '/dashboard/orders/manage-items' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_COLUMN_HEADER, FIRST_CARD, PAGER],
  },
  {
    board: 'Return-Detail',
    route: { kind: 'first', list: '/dashboard/returns', link: 'a[href^="/dashboard/returns/"]' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Cycle-Counts',
    route: { kind: 'path', path: '/dashboard/cycle-counts' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_COLUMN_HEADER, FIRST_CARD, PAGER],
  },
  {
    board: 'Cycle-Count-Detail',
    route: {
      kind: 'first',
      list: '/dashboard/cycle-counts',
      link: 'a[href^="/dashboard/cycle-counts/"]:not([href$="/new"])',
    },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Purchase-Order',
    route: {
      kind: 'first',
      list: '/dashboard/purchase-orders',
      link: 'a[href^="/dashboard/purchase-orders/"]:not([href$="/new"])',
    },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Reports',
    route: { kind: 'path', path: '/dashboard/reports' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Book-Order-Totals',
    route: { kind: 'path', path: '/dashboard/reports/book-order-totals' },
    auth: 'signed-in',
    landmarks: [...SHELL, PAGE_HEADER, FIRST_CARD],
  },
  {
    board: 'Auth-SignIn',
    route: { kind: 'path', path: '/signin' },
    auth: 'signed-out',
    landmarks: [{ name: 'h1', board: 'h1', app: 'h1', fixed: false }],
  },
  // The 390 px boards (drawn in their default variant only): geometry at the phone width.
  ...(
    [
      ['Overview-Mobile', { kind: 'path', path: '/dashboard' }],
      ['Items-Mobile', { kind: 'path', path: '/dashboard/inventory' }],
      ['Order-New-Mobile', { kind: 'path', path: '/dashboard/orders/new' }],
      [
        'Order-Detail-Mobile',
        { kind: 'first', list: '/dashboard/orders', link: 'a[href^="/dashboard/orders/"]' },
      ],
    ] as const
  ).map(([board, route]): BoardTarget => ({
    board,
    route,
    auth: 'signed-in',
    variants: ['default'],
    landmarks: [
      { name: 'topbar', board: 'header.topbar', app: '[data-glass="topbar"]', fixed: true },
      { name: 'h1', board: 'h1', app: 'main h1', fixed: false },
    ],
  })),
  {
    board: 'Auth-SignIn-Mobile',
    route: { kind: 'path', path: '/signin' },
    auth: 'signed-out',
    variants: ['default'],
    landmarks: [{ name: 'h1', board: 'h1', app: 'h1', fixed: false }],
  },
];

/** The board variants that are exact structural references (plan 8.1: no scene). */
export const EXACT_VARIANTS = ['reduced', 'contrast'] as const;
export type ExactVariant = (typeof EXACT_VARIANTS)[number];

/** One board, one variant, as exported. */
export interface BoardRecord {
  board: string;
  variant: string;
  viewport: { w: number; h: number };
  /** Selector set the exporter used, by landmark name (the copy the spec checks). */
  selectors: Record<string, string>;
  landmarks: Record<string, Measured>;
  /** Landmarks whose selector matched nothing visible on the board. */
  missing: string[];
}

/** What the exporter measures on one board: every variant, every landmark's board selector. */
export interface ExportTarget {
  board: string;
  variants: string[];
  landmarks: { name: string; board: string }[];
}

export interface BoardLandmarksFile {
  format: 1;
  source: string;
  exportedAt: string | null;
  /** The exporter's input: exportTargets() of this file, copied (a unit test keeps the copy equal). */
  targets: ExportTarget[];
  /** Empty until the exporter has run (then every listed variant of every target). */
  boards: BoardRecord[];
}

/**
 * The exporter's input derived from BOARD_TARGETS: one entry per board (a
 * board measured in two states merges its landmark lists), sorted by board.
 */
export function exportTargets(targets: readonly BoardTarget[] = BOARD_TARGETS): ExportTarget[] {
  const byBoard = new Map<string, ExportTarget>();
  for (const t of targets) {
    const entry = byBoard.get(t.board) ?? { board: t.board, variants: [], landmarks: [] };
    for (const v of variantsOf(t)) if (!entry.variants.includes(v)) entry.variants.push(v);
    for (const l of t.landmarks)
      if (!entry.landmarks.some((x) => x.name === l.name))
        entry.landmarks.push({ name: l.name, board: l.board });
    byBoard.set(t.board, entry);
  }
  return [...byBoard.values()].sort((a, b) => a.board.localeCompare(b.board));
}

export const POSITION_TOLERANCE_PX = 2;
export const SIZE_TOLERANCE_PX = 1;

/**
 * Geometry problems of one landmark (empty: within tolerance). Coordinates are
 * CSS px in the viewport at scroll 0, as both sides measure them.
 */
export function boxProblems(name: string, board: Box, app: Box, fixed: boolean): string[] {
  const out: string[] = [];
  const pos = (axis: 'x' | 'y') => {
    const d = app[axis] - board[axis];
    if (Math.abs(d) > POSITION_TOLERANCE_PX)
      out.push(`${name}: ${axis} ${fmt(app[axis])} vs board ${fmt(board[axis])} (${signed(d)} px)`);
  };
  const size = (axis: 'w' | 'h') => {
    const d = app[axis] - board[axis];
    if (Math.abs(d) > SIZE_TOLERANCE_PX)
      out.push(
        `${name}: ${axis === 'w' ? 'width' : 'height'} ${fmt(app[axis])} vs board ${fmt(board[axis])} (${signed(d)} px)`,
      );
  };
  pos('x');
  pos('y');
  size('w');
  if (fixed) size('h');
  return out;
}

/** Differences the plan names as unavoidable (8.1-3): reported per row, never failed. */
export const KNOWN_STYLE_GAPS: ReadonlySet<StyleProp> = new Set<StyleProp>(['fontFamily']);

const firstFamily = (v: string) =>
  (v.split(',')[0] ?? '')
    .trim()
    .replace(/^["']|["']$/gu, '')
    .toLowerCase();

const norm = (v: string) => v.replace(/\s+/gu, ' ').trim().toLowerCase();

/**
 * Style differences of one landmark: `fail` must be empty for a pass, `gaps`
 * are the known unavoidable ones (reported in COVERAGE "Remaining gaps").
 * A colour compares by delta E 2000 < 1 only when both sides are opaque;
 * a translucent colour (glass) is compared as written.
 */
export function styleProblems(
  name: string,
  board: StyleRecord,
  app: StyleRecord,
): { fail: string[]; gaps: string[] } {
  const fail: string[] = [];
  const gaps: string[] = [];
  for (const prop of STYLE_PROPS) {
    const b = board[prop];
    const a = app[prop];
    if (b === undefined || a === undefined) continue;
    let same: boolean;
    if (prop === 'fontFamily') same = firstFamily(a) === firstFamily(b);
    else if (prop === 'color' || prop === 'backgroundColor') {
      const cb = parseCssColor(b);
      const ca = parseCssColor(a);
      if (cb === null || ca === null) same = norm(a) === norm(b);
      else if (cb.a >= 0.999 && ca.a >= 0.999)
        same = deltaE00Rgb([ca.r, ca.g, ca.b], [cb.r, cb.g, cb.b]) < 1;
      else
        same =
          Math.abs(ca.a - cb.a) < 0.01 &&
          Math.abs(ca.r - cb.r) < 1.5 &&
          Math.abs(ca.g - cb.g) < 1.5 &&
          Math.abs(ca.b - cb.b) < 1.5;
    } else if (prop === 'letterSpacing') {
      // "normal" and "0px" draw the same.
      const z = (v: string) => (norm(v) === 'normal' ? '0px' : norm(v));
      same = z(a) === z(b);
    } else same = norm(a) === norm(b);
    if (!same) {
      const line = `${name}: ${prop} ${a} vs board ${b}`;
      (KNOWN_STYLE_GAPS.has(prop) ? gaps : fail).push(line);
    }
  }
  return { fail, gaps };
}

/** The selector copy the exporter wrote must equal this file's definitions. */
export function selectorDrift(target: BoardTarget, record: BoardRecord): string[] {
  const out: string[] = [];
  for (const def of target.landmarks) {
    const got = record.selectors[def.name];
    if (got !== def.board)
      out.push(`${target.board} ${def.name}: board selector ${got ?? '(none)'} != ${def.board}`);
  }
  return out;
}

/**
 * The landmarks of `target` the board actually draws in `record` (the ones
 * that can be compared). Empty: the board draws none of them (Items in the
 * selection state: the board has no selection bar), so a comparison would be
 * vacuous and the spec skips with the reason instead of passing.
 */
export function comparableLandmarks(target: BoardTarget, record: BoardRecord): LandmarkDef[] {
  return target.landmarks.filter((def) => record.landmarks[def.name] !== undefined);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${fmt(n)}`;
}
