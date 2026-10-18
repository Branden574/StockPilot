import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ORDERS_LIST_EMPTY_TITLE_COPY,
  ORDERS_LIST_LOAD_FAILED_BODY_COPY,
  ORDERS_LIST_LOAD_FAILED_TITLE_COPY,
  ORDERS_LIST_RELOAD_FAILED_COPY,
  ORDER_STATUS_KEYS,
} from '@stockpilot/core';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { dataListEmptyKind, dataListReloadNote } from '../components/ui/data-list-state';
import { buttonTone, pillTone } from '../components/ui/tones';
import {
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { orderStatusPill, ordersListEmpty, ordersListReloadNote } from './orders-list';
import { palette, type Palette } from './theme';

/**
 * THE ORDERS LIST, THE STOREFRONT, CHECKOUT AND THE PLACED SCREEN, READ AS
 * SOURCE (redesign package P5.7a; rows M-OR-01 Orders, 03 storefront home,
 * 04 browse, 05 checkout, 06 placed, 09 the storefront's sheets and cart).
 *
 * The look moved onto the per-mode palette and the shared recipes: the
 * shared button tones (Place an order is the accent, the page-level create
 * action; Submit order request and Check out the ink commit), controls edged
 * in the stronger border, text boxes on the shared Field recipe with muted
 * (AA) placeholders, the reference's segmented switch, photos on white in
 * both modes, status words on tone pills. These pin what had to survive it
 * (the words, gates, tour targets, the failed-read rule, the iPad cart column
 * and the virtualised list's rows) and the look's measured contrast. The
 * existing call-site pins (order-storefront-wiring.test.ts) keep the
 * storefront's behaviour; this file pins the redesign's part.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const FILES = {
  orders: 'src/screens/orders.tsx',
  drawerOrders: 'app/(drawer)/orders.tsx',
  index: 'app/order/new/index.tsx',
  browse: 'app/order/new/browse.tsx',
  checkout: 'app/order/new/checkout.tsx',
  placed: 'app/order/new/placed.tsx',
  catalog: 'src/components/order-storefront/catalog-screen.tsx',
  controls: 'src/components/order-storefront/controls.tsx',
  itemRow: 'src/components/order-storefront/item-row.tsx',
  kitRow: 'src/components/order-storefront/kit-row.tsx',
  cart: 'src/components/order-storefront/cart-panel.tsx',
  sheets: 'src/components/order-storefront/sheets.tsx',
  frame: 'src/components/order-storefront/storefront-sheet.tsx',
  state: 'src/components/order-storefront/storefront-state.tsx',
  panel: 'src/components/order-storefront/unconfirmed-panel.tsx',
} as const;

const MODES: [string, Palette][] = [
  ['light', palette('light')],
  ['dark', palette('dark')],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const flat = (s: string) => s.replace(/\s+/g, ' ');

type Found = { el: JsxNode; ancestors: JsxNode[] };

function treeOf(file: string): { sf: ts.SourceFile; all: Found[] } {
  const sf = parseTsx(sourceOf(file), file);
  const all: Found[] = [];
  walkJsx(sf, (el, ancestors) => all.push({ el, ancestors: [...ancestors] }));
  return { sf, all };
}

/** Everything a person can read or hear in a file: JSX text and literals. */
function wordsOf(file: string): string[] {
  const sf = parseTsx(sourceOf(file), file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ── The palette ────────────────────────────────────────────────────────────

describe('the per-mode palette on the Orders list and the storefront', () => {
  const all = Object.values(FILES);

  it.each(all)('%s: no ACCENT, paper2, legacy theme, MintWash, fixed colour or hitSlop', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/\bpaper2\b/);
    expect(code).not.toMatch(/\bMintWash\b/);
    expect(code).not.toMatch(/import \{[^}]*\btheme\b[^}]*\} from '@\/lib\/theme'/);
    expect(code).not.toMatch(/['"]#[0-9a-fA-F]{3,8}['"]/);
    expect(code).not.toMatch(/\bhitSlop\b/);
  });

  // Mutation caught: a placeholder back in the decoration ink (ink4, 3.2-3.6:1;
  // the search, the notes, the person's name and email, the requester search).
  it.each(all)('%s: words and placeholders in ink3 or stronger; ink4 only on an arrow', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).not.toMatch(/\bc\.ink5\b/);
    expect(code).not.toMatch(/placeholderTextColor=\{c\.ink4\}/);
    for (const m of code.matchAll(/<(Body|Mono|Text|Eyebrow|FieldLabel|Display)\b[^>]*>/g)) {
      expect(m[0], `${file}: ${m[0].slice(0, 90)}`).not.toMatch(/c\.ink4/);
    }
    const uses = [...code.matchAll(/[^\n]*\bc\.ink4\b[^\n]*/g)].map((m) => m[0].trim());
    expect(uses).toEqual(
      file === FILES.catalog ? ['<ChevronRight size={16} color={c.ink4} strokeWidth={1.5} />'] : [],
    );
  });

  it.each([FILES.sheets, FILES.catalog, FILES.checkout, 'src/components/needed-by-picker.tsx'])(
    '%s: every placeholder is the muted ink (AA), as the shared text box draws it',
    (file) => {
      const code = codeOnly(sourceOf(file));
      const placeholders = [...code.matchAll(/placeholderTextColor=\{([^}]+)\}/g)].map((m) => m[1]);
      expect(placeholders.length).toBeGreaterThan(0);
      expect(new Set(placeholders)).toEqual(new Set(['c.ink3']));
      for (const [mode, c] of MODES) {
        expect(contrast(c.ink3, c.card), `${mode}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    },
  );
});

// ── The Orders list ────────────────────────────────────────────────────────

describe('Orders list (M-OR-01)', () => {
  const code = codeOnly(sourceOf(FILES.orders));
  const f = flat(code);

  it('both routes render the one screen (the drawer and the optional tab)', () => {
    expect(codeOnly(sourceOf(FILES.drawerOrders))).toContain(
      "export { default } from '@/screens/orders';",
    );
    expect(codeOnly(sourceOf('app/(drawer)/(tabs)/orders-tab.tsx'))).toContain('@/screens/orders');
  });

  // D25: a failed read is DataListScreen's failed panel in the list's own
  // words, never "No orders yet."; a failed read again over rows keeps them
  // and says so above them. Run here through DataListScreen's own rules.
  it('a failed read says the list could not be loaded, with Load again; rows a failed re-read kept are said to be old', () => {
    expect(code).toContain('const empty = ordersListEmpty(false, canApprove);');
    expect(code).toContain('const failure = ordersListEmpty(true, canApprove);');
    expect(f).toContain('failed={ failed ? { title: failure.title, body: failure.body,');
    expect(f).toContain('reloadNote: reloadNote ?? undefined,');
    expect(code).not.toMatch(/ordersListEmpty\(failed/);
    for (const approver of [true, false]) {
      const failure = ordersListEmpty(true, approver);
      expect(failure).toEqual({
        title: ORDERS_LIST_LOAD_FAILED_TITLE_COPY,
        body: ORDERS_LIST_LOAD_FAILED_BODY_COPY,
      });
      expect(ordersListEmpty(false, approver).title).toBe(ORDERS_LIST_EMPTY_TITLE_COPY);
      // No rows: the failed panel, its words, never the empty words.
      const none = {
        title: failure.title,
        body: failure.body,
        reloadNote: ordersListReloadNote(true, 0) ?? undefined,
      };
      expect(dataListEmptyKind(none)).toBe('failed');
      expect(dataListReloadNote(none, 0)).toBeNull();
      // Rows from an earlier read: they stay, with the list's own note.
      const some = {
        title: failure.title,
        body: failure.body,
        reloadNote: ordersListReloadNote(true, 3) ?? undefined,
      };
      expect(dataListReloadNote(some, 3)).toBe(ORDERS_LIST_RELOAD_FAILED_COPY);
    }
    // A read that succeeded: no failure at all.
    expect(dataListEmptyKind(null)).toBe('empty');
  });

  // The P2.5 hand-off: "Place an order" creates something new at page level,
  // so it is the accent button; the "+" keeps the same gate and tour target.
  it('the empty state\'s Place an order is the accent button, behind the same gate as "+"', () => {
    expect(f).toContain(
      'emptyAction={ canPlace ? ( <Button variant="accent" onPress={placeAnOrder}> {STOREFRONT_TITLE_COPY} </Button> ) : undefined }',
    );
    expect(code).toMatch(
      /<IconChip icon=\{Plus\} onPress=\{placeAnOrder\} accessibilityLabel=\{STOREFRONT_TITLE_COPY\} minTap \/>/,
    );
    expect(code).toContain("const placeTargetRef = useTourTarget('orders-place-order');");
    expect(code).toContain("const firstRowTargetRef = useTourTarget('orders-first-row');");
    expect(code).toContain('<MobileTour tour={MOBILE_ORDERS_TOUR} />');
    for (const [mode, c] of MODES) {
      const accent = buttonTone('accent', c);
      expect(contrast(accent.fg, accent.bg), `${mode} accent words`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    }
  });

  // The card opens the order: VoiceOver now hears a button (it read the
  // card's words with no role). Its details are muted ink, never ink4.
  it('an order card is a button; its details in muted ink; its status on the tone pill', () => {
    const { sf, all } = treeOf(FILES.orders);
    const cards = all.filter(
      (n) => attrText(n.el, 'onPress', sf) === '() => router.push(`/order/${order.id}` as Href)',
    );
    expect(cards).toHaveLength(1);
    expect(attrText(cards[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(code).toContain('const meta = orderStatusPill(order.status, order.fulfillment_type);');
    expect(code).toMatch(/<Pill status=\{meta\.status\}>\{meta\.label\}<\/Pill>/);
    for (const key of ORDER_STATUS_KEYS) {
      for (const [mode, c] of MODES) {
        const tone = pillTone(orderStatusPill(key).status, c);
        expect(contrast(tone.fg, tone.bg), `${mode} ${key}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps every word', () => {
    const words = wordsOf(FILES.orders);
    for (const w of ['Order', 'requests.', 'No warehouse', 'line', 'lines']) {
      expect(words, w).toContain(w);
    }
    expect(code).toContain('eyebrow={`ORDERS · ${pendingCount} PENDING`}');
    expect(code).toContain('{ORDERS_LIST_UNCONFIRMED_COPY}');
    expect(code).toContain(
      '<SmallAction label={ORDERS_LIST_OPEN_UNCONFIRMED_COPY} onPress={placeAnOrder} />',
    );
  });
});

// ── The storefront's controls ─────────────────────────────────────────────

describe("the storefront's controls on the shared recipes (M-OR-09)", () => {
  const code = codeOnly(sourceOf(FILES.controls));

  it('a small action draws with the shared button tones, its words in the display face', () => {
    expect(code).toContain('const tone = buttonTone(variant, c);');
    expect(code).toContain('backgroundColor: tone.bg,');
    expect(code).toContain('borderColor: tone.border,');
    expect(code).toMatch(
      /<Body size=\{13\} color=\{fg\} maxFontSizeMultiplier=\{ACTION_CAP\} style=\{styles\.label\}>\s*\{label\}/,
    );
    expect(code).toMatch(
      /label: \{ fontFamily: FONT\.display, flexShrink: 1, textAlign: 'center' \}/,
    );
    for (const [mode, c] of MODES) {
      for (const variant of ['primary', 'outline', 'ghost', 'destructive'] as const) {
        const t = buttonTone(variant, c);
        const under = t.bg === 'transparent' ? c.card : t.bg;
        expect(contrast(t.fg, under), `${mode} ${variant}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  // Pickup or Delivery: the reference's segmented switch. The chosen segment
  // is the card on the recessed track, ringed in muted ink at 3:1 or more
  // (the reference's hairline ring is 1.4:1), its words ink and semibold.
  it("Pickup or Delivery is the reference's segmented switch, and the choice reads by more than a faint fill", () => {
    const f = flat(code);
    expect(f).toContain('style={[styles.segmented, { backgroundColor: c.sunk }]}');
    expect(f).toContain(
      "backgroundColor: checked ? c.card : 'transparent', borderColor: checked ? c.ink3 : 'transparent',",
    );
    expect(f).toContain('color={checked ? c.ink : c.ink3}');
    expect(f).toContain('style={[styles.label, checked && styles.labelOn]}');
    expect(code).toContain('labelOn: { fontFamily: FONT.displaySemi },');
    for (const [mode, c] of MODES) {
      expect(contrast(c.ink3, c.sunk), `${mode} ring on the track`).toBeGreaterThanOrEqual(AA_UI);
      expect(contrast(c.ink, c.card), `${mode} chosen words`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(c.ink3, c.sunk), `${mode} other words`).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // Still a radio group of radios with their state, at 44pt.
    expect(code).toContain('accessibilityRole="radiogroup"');
    expect(code.match(/accessibilityRole="radio"/g)).toHaveLength(2);
    expect(code).toMatch(/segment: \{[^}]*minHeight: MIN_TAP,/);
  });

  it('controls are edged in the stronger border; a read-only setup row keeps the hairline', () => {
    expect(code).toContain(
      '<View style={[styles.stepper, { borderColor: c.hair2, backgroundColor: c.card }]}>',
    );
    expect(code).toContain('borderColor: checked ? c.ink : c.hair2,');
    expect(code).toContain(
      'style={[styles.setup, { borderColor: c.hair, backgroundColor: c.card }]}',
    );
    expect(flat(code)).toContain(
      '{ borderColor: c.hair2, backgroundColor: c.card, opacity: disabled ? 0.6 : pressed ? 0.85 : 1 },',
    );
  });
});

describe('item and kit rows, the cart and the sheets', () => {
  it("a row is the reference's card; its photo on white in both modes, its letter on the recessed fill", () => {
    const code = codeOnly(sourceOf(FILES.itemRow));
    expect(flat(code)).toContain(
      '{ backgroundColor: photoUrl ? PHOTO_BACKGROUND : c.sunk, borderColor: c.hair },',
    );
    expect(code).toContain('<View style={[styles.chip, { borderColor: c.hair2 }]}>');
    for (const file of [FILES.itemRow, FILES.kitRow]) {
      expect(codeOnly(sourceOf(file)), file).toMatch(/borderRadius: RADIUS\.card,/);
    }
  });

  it("the quantity box is the count input; the person's name, email and search are the shared text box", () => {
    const code = flat(codeOnly(sourceOf(FILES.sheets)));
    expect(code).toContain(
      'width: pickQtyFieldWidthFor(digits), borderColor: c.hair2, backgroundColor: c.sunk, color: c.ink,',
    );
    expect(code).toContain(
      'const inputStyle = [styles.input, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }];',
    );
    expect(code).toContain('backgroundColor: PHOTO_BACKGROUND,');
  });

  it("a sheet's Close is a named 44pt button whose X reads at 3:1 and more", () => {
    const code = codeOnly(sourceOf(FILES.frame));
    expect(code).toContain('<X size={18} color={c.ink2} />');
    expect(code).toContain('accessibilityLabel={STOREFRONT_CLOSE_COPY}');
    expect(code).toMatch(/close: \{\s*minWidth: MIN_TAP,\s*minHeight: MIN_TAP,/);
  });

  it('Check out on the cart bar is the ink button with its words in the display face', () => {
    const code = codeOnly(sourceOf(FILES.cart));
    expect(flat(code)).toContain(
      "<Body size={13.5} color={c.paper} maxFontSizeMultiplier={BAR_CAP} style={{ fontFamily: FONT.display, textAlign: 'center' }} > {CART_CHECK_OUT_COPY} </Body>",
    );
    expect(code).toContain('styles.barCheckout, { backgroundColor: c.ink,');
  });
});

describe('the catalog keeps its list, its iPad cart column and its search (M-OR-03, 04)', () => {
  const code = codeOnly(sourceOf(FILES.catalog));

  it('every kind of row is still drawn: sections, items, kits, categories, All items, See all, notes, no match', () => {
    for (const kind of [
      'header',
      'item',
      'kit',
      'category',
      'all-items',
      'see-all',
      'note',
      'empty',
    ]) {
      expect(code, kind).toContain(`case '${kind}':`);
    }
  });

  it('the iPad cart column, beside the list, with Check out; the phone keeps the bar', () => {
    expect(code).toMatch(/\{layout\.kind === 'split' \? \(/);
    expect(code).toContain(
      'styles.cartColumn, { width: layout.cartColumnWidth, borderColor: c.hair, backgroundColor: c.card }',
    );
    expect(code).toContain(
      '<SmallAction label={CART_CHECK_OUT_COPY} variant="primary" onPress={checkOut} />',
    );
    expect(code).toContain(
      "<CartBar cart={cart} onOpenCart={() => setSheet({ kind: 'cart' })} onCheckOut={checkOut} />",
    );
  });

  it('the search and Sort & filter are the shared text box and an outline control', () => {
    expect(code).toContain(
      'style={[styles.search, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }]}',
    );
    expect(code).toContain(
      'style={[styles.filterButton, { borderColor: c.hair2, backgroundColor: c.card }]}',
    );
    expect(code).toMatch(/link: \{[^}]*borderRadius: RADIUS\.card,/);
  });
});

describe('checkout and the placed screen (M-OR-05, 06)', () => {
  it('Submit order request is the ink button on the shared corner (no pill), with its gate and words', () => {
    const src = sourceOf(FILES.checkout);
    const code = codeOnly(src);
    expect(src).toMatch(
      /\n {2}submit: \{\s*minHeight: Math\.max\(MIN_TAP, 52\),\s*borderRadius: BUTTON_RADIUS\.md,/,
    );
    expect(code).not.toMatch(/borderRadius: 999/);
    expect(flat(code)).toContain(
      '{ backgroundColor: c.ink, opacity: blockedBy === null || sending ? 1 : 0.5 },',
    );
    expect(code).toContain('accessibilityLabel={REVIEW_SUBMIT_COPY}');
    expect(code).toContain('{REVIEW_SUBMIT_COPY}');
  });

  it('every checkout field is still there, the notes on the shared text box', () => {
    const code = codeOnly(sourceOf(FILES.checkout));
    for (const label of [
      'STOREFRONT_SHIP_FROM_COPY',
      'STOREFRONT_FOR_COPY',
      'STOREFRONT_DELIVER_TO_COPY',
      'CART_NEEDED_BY_LABEL_COPY',
      'STOREFRONT_PICKUP_OR_DELIVERY_COPY',
      'CHECKOUT_PICKUP_COPY',
      'CHECKOUT_DELIVERY_COPY',
      'CART_MANAGER_NOTES_LABEL_COPY',
      'CART_SUBMIT_FINE_PRINT_COPY',
    ]) {
      expect(code, label).toContain(label);
    }
    expect(code).toContain(
      'style={[styles.notes, { borderColor: c.hair2, backgroundColor: c.card, color: c.ink }]}',
    );
  });

  it("the placed screen's status is its tone's pill, in the same words; its notes in muted ink", () => {
    const code = codeOnly(sourceOf(FILES.placed));
    expect(code).toMatch(
      /<Pill status=\{orderStatusPill\(order\.status\)\.status\}>\s*\{orderStatusLabel\(order\.status\)\.toUpperCase\(\)\}\s*<\/Pill>/,
    );
    for (const words of [
      'recipientsHelperText(prepared.draft)',
      'HONESTY_NOTICE',
      'OVERSIZED_MESSAGE',
      'DUPLICATE_WARNING',
    ]) {
      expect(code).toMatch(
        new RegExp(
          `<Body size=\\{12\\.5\\} color=\\{c\\.ink3\\}>\\s*\\{${words.replace(/[.()]/g, '\\$&')}\\}`,
        ),
      );
    }
    expect(flat(code)).toContain(
      '{ color: c.ink, borderColor: c.hair2, backgroundColor: c.card },',
    );
    // Review and approve / View order stays the one ink action.
    expect(flat(code)).toContain(
      'label={canApprove ? SUCCESS_REVIEW_AND_APPROVE_COPY : SUCCESS_VIEW_ORDER_COPY} variant="primary"',
    );
  });

  it('the needed-by picker: chips edged in the stronger border, the chosen one in ink, a bad time in the warning ink', () => {
    const code = codeOnly(sourceOf('src/components/needed-by-picker.tsx'));
    expect(code).toContain('borderColor: selected ? c.ink : c.hair2,');
    expect(code).toContain('? c.warnText\n              : c.ink3');
    expect(code).toContain('{ borderColor: c.hair2, backgroundColor: c.card, color: c.ink },');
    for (const [mode, c] of MODES) {
      expect(contrast(c.paper, c.ink), `${mode} chosen chip words`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('the storefront screens are unchanged routes', () => {
  it('home and browse are the one catalog screen', () => {
    expect(codeOnly(sourceOf(FILES.index))).toContain('<CatalogScreen target={null} />');
    expect(codeOnly(sourceOf(FILES.browse))).toContain('<CatalogScreen target={target} />');
    const { sf, all } = treeOf(FILES.index);
    expect(all.map((n) => tagOf(n.el, sf))).toEqual(['CatalogScreen']);
  });
});
