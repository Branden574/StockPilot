/**
 * copy.ts holds TODAY's storefront words (phone ordering PO-1). Until PO-2
 * moves the web onto it, the web components keep their own literals, so this
 * guard reads the web storefront's source and checks that every sentence here
 * still appears there, word for word. A change to the words on either side
 * fails it: PO-2 changes both together.
 *
 * Sentences built from a value are checked by their fixed parts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as copy from './copy';

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

const WEB = readable(FILES.map((f) => readFileSync(path.join(STOREFRONT, f), 'utf8')).join('\n'));

/** Every exported string constant in copy.ts. */
const CONSTANTS: Array<[string, string]> = Object.entries(copy as Record<string, unknown>).flatMap(
  ([name, value]) => (typeof value === 'string' ? [[name, value] as [string, string]] : []),
);

describe("copy.ts holds the web storefront's words of today", () => {
  it('has the constants this guard walks', () => {
    expect(CONSTANTS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CONSTANTS)('%s appears in the web storefront', (_name, text) => {
    expect(WEB).toContain(text.replace(/\s+/g, ' '));
  });

  // Each function's fixed parts, for a value of each kind it takes.
  const templated: Array<[string, string[]]> = [
    ['storefrontNothingMatchesCopy', ['Nothing matches', ' “', ' those filters']],
    ['frequentlyOrderedTagCopy', ['#{i + 1} · {count}×/mo']],
    ['cartLineAtMaxCopy', ['`All ${available} available are in your cart`']],
    ['cartLineOverCopy', ['`Only ${available} in stock — reduce quantity`']],
    ['kitsAvailableCopy', ["`${kits} ${kits === 1 ? 'kit' : 'kits'} available`"]],
    [
      'kitLimitedByCopy',
      ['Limited by {nameOf(availability.limiting.component)} ( {availability.limiting.available})'],
    ],
    ['kitNotEnoughCopy', ['`Not enough ${name} for that many kits. Nothing was added.`']],
    [
      'successNotifiedCopy',
      [
        "Your manager has been notified. You'll get an email when it's approved and stock is reserved for {summary.method === 'pickup' ? 'pickup' : 'delivery'}.",
      ],
    ],
  ];

  it.each(templated)("%s's fixed parts appear in the web storefront", (_name, parts) => {
    for (const part of parts) expect(WEB).toContain(part);
  });

  it('the templated sentences read as the web renders them', () => {
    expect(copy.storefrontNothingMatchesCopy('polo')).toBe('Nothing matches “polo”');
    expect(copy.storefrontNothingMatchesCopy('')).toBe('Nothing matches those filters');
    expect(copy.frequentlyOrderedTagCopy(1, 12)).toBe('#1 · 12×/mo');
    expect(copy.cartLineAtMaxCopy(8)).toBe('All 8 available are in your cart');
    expect(copy.cartLineOverCopy(3)).toBe('Only 3 in stock — reduce quantity');
    expect(copy.kitsAvailableCopy(1)).toBe('1 kit available');
    expect(copy.kitsAvailableCopy(60)).toBe('60 kits available');
    expect(copy.kitLimitedByCopy('Backpack', 60)).toBe('Limited by Backpack (60)');
    expect(copy.kitNotEnoughCopy('Backpack')).toBe(
      'Not enough Backpack for that many kits. Nothing was added.',
    );
    expect(copy.successNotifiedCopy('pickup')).toBe(
      "Your manager has been notified. You'll get an email when it's approved and stock is reserved for pickup.",
    );
    expect(copy.successNotifiedCopy('delivery')).toMatch(/reserved for delivery\.$/);
  });

  it('every function in copy.ts is covered above', () => {
    const functions = Object.entries(copy)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort();
    expect(functions).toEqual(templated.map(([k]) => k).sort());
  });
});
