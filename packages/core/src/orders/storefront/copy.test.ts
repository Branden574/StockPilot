/**
 * copy.ts holds the storefront's words for both surfaces (phone ordering
 * PO-2). The web storefront imports them: this guard reads the web
 * storefront's source and checks that
 *   - every name the web shows is imported there by name (the phone-only
 *     names are listed), and
 *   - no sentence of copy.ts is written there as a literal, so a word can
 *     only change in one place;
 * plus what each templated sentence reads, and the words rules every
 * storefront sentence keeps (section 6's guard).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as copy from './copy';
import * as placeOrder from '../place-order';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const STOREFRONT = path.join(ROOT, 'apps/web/src/components/orders/storefront');
const FILES = [
  'orders-storefront.tsx',
  'storefront-cart.tsx',
  'storefront-cards.tsx',
  'storefront-kit-card.tsx',
  'storefront-overlays.tsx',
];

/** The web source as a person reads it: JSX entities decoded, line breaks and
 *  {' '} spacers read as one space. */
function readable(src: string): string {
  return src
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<br\s*\/>/g, ' ')
    .replace(/\{' '\}/g, ' ')
    .replace(/\s+/g, ' ');
}

const RAW = FILES.map((f) => readFileSync(path.join(STOREFRONT, f), 'utf8')).join('\n');
const WEB = readable(RAW);

/** Names only the phone storefront (PO-4) shows. */
const PHONE_ONLY = new Set([
  'STOREFRONT_SITES_LOAD_FAILED_COPY',
  'CART_CHECK_OUT_COPY',
  'SUCCESS_PLACE_ANOTHER_COPY',
  'cartCountsCopy',
]);

/**
 * Names the web cart shows through core's cartLineView (stale-cart.ts, the
 * phone's rule; ordering visibility design 6.5): the web names cartLineView,
 * and stale-cart.ts names these, so each word still changes in one place.
 */
const THROUGH_CART_LINE_VIEW = new Set(['cartLineAtMaxCopy', 'cartLineOverCopy']);
const STALE_CART = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'stale-cart.ts'),
  'utf8',
);

const CONSTANTS: Array<[string, string]> = Object.entries(copy as Record<string, unknown>).flatMap(
  ([name, value]) => (typeof value === 'string' ? [[name, value] as [string, string]] : []),
);
const NAMES = Object.keys(copy).sort();

describe('the web storefront takes its words from copy.ts', () => {
  it('has the constants this guard walks', () => {
    expect(CONSTANTS.length).toBeGreaterThanOrEqual(45);
  });

  it.each(NAMES.filter((n) => !PHONE_ONLY.has(n)))('%s is used by the web storefront', (name) => {
    if (THROUGH_CART_LINE_VIEW.has(name)) {
      expect(RAW).toMatch(/\bcartLineView\b/);
      expect(STALE_CART).toMatch(new RegExp(`\\b${name}\\b`));
      return;
    }
    expect(RAW).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(CONSTANTS)('%s is not written as a literal in the web storefront', (_name, text) => {
    expect(WEB).not.toContain(`'${text}'`);
    expect(WEB).not.toContain(`"${text}"`);
    expect(WEB).not.toContain(`>${text}<`);
  });

  it('the phone-only names exist (a stale list would hide a web word)', () => {
    for (const name of PHONE_ONLY) expect(NAMES).toContain(name);
  });

  it('the old words are gone from the web storefront', () => {
    for (const old of [
      'Place an Order',
      'Order Cart',
      'Submit Order Request',
      'Requesting for',
      'Based on your last 30 days',
      '×/mo',
      'Most ordered by you',
      'in stock — reduce quantity',
      'Ready within 1 business day of approval',
      "You'll get an email when it's approved",
      'Confirm & submit',
      'A manager will review and approve before stock is reserved.',
    ]) {
      expect(WEB).not.toContain(old);
    }
  });
});

describe('the templated sentences', () => {
  it('read as section 6 says', () => {
    expect(copy.storefrontNothingMatchesCopy('polo')).toBe('Nothing matches “polo”');
    expect(copy.storefrontNothingMatchesCopy('')).toBe('Nothing matches those filters');
    expect(copy.frequentlyOrderedTagCopy(1, 12)).toBe('#1 · in 12 orders');
    expect(copy.frequentlyOrderedTagCopy(2, 1)).toBe('#2 · in 1 order');
    expect(copy.storefrontWillCallDeskCopy('DC4')).toBe('DC4 will-call desk');
    expect(copy.storefrontPickupHintCopy('DC4')).toBe(
      "Collect it at the DC4 will-call desk once it's ready.",
    );
    // A warehouse with no name (no longer listed): never "at the  will-call desk".
    expect(copy.storefrontPickupHintCopy('')).toBe("Collect it at the will-call desk once it's ready.");
    expect(copy.storefrontPickupHintCopy('  ')).toBe("Collect it at the will-call desk once it's ready.");
    expect(copy.cartCountsCopy(3, 12)).toBe('3 items · 12 units');
    expect(copy.cartCountsCopy(1, 1)).toBe('1 item · 1 unit');
    expect(copy.cartLineAtMaxCopy(8)).toBe('All 8 available are in your cart');
    // PO-4 review: "All 1 available are in your cart" (web and phone).
    expect(copy.cartLineAtMaxCopy(1)).toBe('The 1 available is in your cart');
    expect(copy.cartLineOverCopy(3)).toBe('Only 3 available. Reduce the quantity.');
    expect(copy.addAllButtonCopy(8)).toBe('Add all');
    expect(copy.addAllWordsCopy(8, 0)).toBe('Add all 8 available');
    expect(copy.addAllLabelCopy('Planner', 8)).toBe('Add all 8 available: Planner');
    expect(copy.kitsAvailableCopy(1)).toBe('1 kit available');
    expect(copy.kitsAvailableCopy(60)).toBe('60 kits available');
    expect(copy.kitLimitedByCopy('Backpack', 60)).toBe('Limited by Backpack (60)');
    expect(copy.kitNotEnoughCopy('Backpack')).toBe(
      'Not enough Backpack for that many kits. Nothing was added.',
    );
    expect(copy.kitsLoadFailedCopy('web')).toBe(
      'Kits could not be loaded. You can still add their items one by one. Reload the page to try again.',
    );
    expect(copy.kitsLoadFailedCopy('phone')).toBe(
      'Kits could not be loaded. You can still add their items one by one. Pull down to try again.',
    );
    expect(copy.successSentForApprovalCopy({ self: true })).toBe(
      "Sent for approval. You'll be notified in the app when it's approved.",
    );
    expect(
      copy.successSentForApprovalCopy({
        self: false,
        name: 'Pixie Quill',
        email: 'pixie@example.org',
      }),
    ).toBe('Sent for approval. Emails about it go to Pixie Quill at pixie@example.org.');
  });

  it('every function in copy.ts is read above', () => {
    const functions = Object.entries(copy)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(
      [
        'addAllButtonCopy',
        'addAllLabelCopy',
        'addAllWordsCopy',
        'cartCountsCopy',
        'cartLineAtMaxCopy',
        'cartLineOverCopy',
        'frequentlyOrderedTagCopy',
        'kitLimitedByCopy',
        'kitNotEnoughCopy',
        'kitsAvailableCopy',
        'kitsLoadFailedCopy',
        'storefrontNothingMatchesCopy',
        'storefrontPickupHintCopy',
        'storefrontWillCallDeskCopy',
        'successSentForApprovalCopy',
      ].sort(),
    );
  });
});

// "Add all": the button's words and its spoken name, for the web and the phone.
describe('the Add all words', () => {
  const NAME = 'Graph Paper Pad';

  it('the button says Add all, and its name starts with those words', () => {
    expect(copy.addAllButtonCopy(67)).toBe('Add all');
    expect(copy.addAllLabelCopy(NAME, 67)).toBe('Add all 67 available: Graph Paper Pad');
    expect(copy.addAllLabelCopy(NAME, 67, 5)).toBe('Add all 67 available: Graph Paper Pad');
    expect(copy.addAllLabelCopy(NAME, 2, 0)).toBe('Add all 2 available: Graph Paper Pad');
  });

  it('with everything available in the cart it says so', () => {
    expect(copy.addAllWordsCopy(67, 67)).toBe('All 67 available are in your cart');
    expect(copy.addAllLabelCopy(NAME, 67, 67)).toBe('All 67 available are in your cart: Graph Paper Pad');
  });

  it('with more in the cart than is available it never says all of them are in the cart', () => {
    expect(copy.addAllWordsCopy(67, 80)).toBe('Only 67 available. Reduce the quantity');
    expect(copy.addAllLabelCopy(NAME, 67, 80)).toBe('Only 67 available. Reduce the quantity: Graph Paper Pad');
    expect(copy.addAllLabelCopy(NAME, 67, 80)).not.toMatch(/\bAll 67\b/);
  });

  it('above the most one order can hold it never says all', () => {
    const cap = placeOrder.ORDER_MAX_UNITS_PER_LINE;
    expect(cap).toBe(10_000);
    expect(copy.addAllButtonCopy(25_000)).toBe('Add 10,000');
    expect(copy.addAllButtonCopy(cap)).toBe('Add all');
    expect(copy.addAllButtonCopy(cap + 1)).toBe('Add 10,000');
    expect(copy.addAllLabelCopy(NAME, 25_000)).toBe('Add 10,000, the most one order can hold: Graph Paper Pad');
    expect(copy.addAllLabelCopy(NAME, 25_000, 9_999)).toBe('Add 10,000, the most one order can hold: Graph Paper Pad');
    expect(copy.addAllLabelCopy(NAME, 25_000, cap)).toBe(
      '10,000 are in your cart, the most one order can hold: Graph Paper Pad',
    );
    for (const inCart of [0, 9_999, cap]) {
      expect(copy.addAllLabelCopy(NAME, 25_000, inCart)).not.toMatch(/\ball\b/i);
      expect(copy.addAllLabelCopy(NAME, 25_000, inCart)).not.toContain('25');
    }
  });

  it('the limit in the words is the order limit, read by name', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'copy.ts'), 'utf8');
    expect(src).toMatch(/import \{ ORDER_MAX_UNITS_PER_LINE \} from '\.\.\/place-order';/);
    // Comments may say the number; the code may not retype it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/10[_,]?000/);
  });
});

describe('the words rules (plan section 6)', () => {
  const sentences = [
    ...CONSTANTS.map(([, v]) => v),
    ...Object.entries(placeOrder as Record<string, unknown>)
      .filter(([k, v]) => k.endsWith('_COPY') && typeof v === 'string')
      .map(([, v]) => v as string),
    copy.successSentForApprovalCopy({
      self: false,
      name: 'Pixie Quill',
      email: 'pixie@example.org',
    }),
    copy.storefrontPickupHintCopy('DC4'),
    copy.kitsLoadFailedCopy('web'),
  ];

  it('no sentence carries a uuid or a snake_case token', () => {
    for (const s of sentences) {
      expect(s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(s).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });

  it('no sentence says "book" for a quantity or "sent" for an email draft', () => {
    for (const s of sentences) {
      expect(s).not.toMatch(/\bbook\b/i);
      expect(s).not.toMatch(/email (was )?sent|sent the email/i);
    }
  });

  it('an outcome that is not known never says "try again"', () => {
    expect(placeOrder.ORDER_FAULT_COPY).not.toMatch(/try again/i);
    expect(placeOrder.ORDER_UNCONFIRMED_BODY_COPY).not.toMatch(/try again/i);
    expect(placeOrder.ORDER_BUSY_COPY).not.toMatch(/try again/i);
  });
});
