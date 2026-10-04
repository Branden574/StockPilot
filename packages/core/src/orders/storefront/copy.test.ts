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

const CONSTANTS: Array<[string, string]> = Object.entries(copy as Record<string, unknown>).flatMap(
  ([name, value]) => (typeof value === 'string' ? [[name, value] as [string, string]] : []),
);
const NAMES = Object.keys(copy).sort();

describe('the web storefront takes its words from copy.ts', () => {
  it('has the constants this guard walks', () => {
    expect(CONSTANTS.length).toBeGreaterThanOrEqual(45);
  });

  it.each(NAMES.filter((n) => !PHONE_ONLY.has(n)))('%s is used by the web storefront', (name) => {
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
    expect(copy.cartLineOverCopy(3)).toBe('Only 3 available. Reduce the quantity.');
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
        name: 'Maria Lopez',
        email: 'maria@example.org',
      }),
    ).toBe('Sent for approval. Emails about it go to Maria Lopez at maria@example.org.');
  });

  it('every function in copy.ts is read above', () => {
    const functions = Object.entries(copy)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(
      [
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

describe('the words rules (plan section 6)', () => {
  const sentences = [
    ...CONSTANTS.map(([, v]) => v),
    ...Object.entries(placeOrder as Record<string, unknown>)
      .filter(([k, v]) => k.endsWith('_COPY') && typeof v === 'string')
      .map(([, v]) => v as string),
    copy.successSentForApprovalCopy({
      self: false,
      name: 'Maria Lopez',
      email: 'maria@example.org',
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
