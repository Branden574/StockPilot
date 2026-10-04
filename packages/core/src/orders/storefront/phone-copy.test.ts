/**
 * The phone storefront's own words (phone-copy.ts, PO-4): what each templated
 * sentence reads, the words rules, and that importing the module runs nothing
 * (the phone evaluates core's whole index at start-up; Metro does not
 * tree-shake).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as copy from './copy';
import * as phone from './phone-copy';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('the templated sentences', () => {
  it('read as the plan says', () => {
    expect(phone.storefrontSeeAllCopy(12)).toBe('See all 12');
    expect(phone.storefrontItemCountCopy(1)).toBe('1 item');
    expect(phone.storefrontItemCountCopy(24)).toBe('24 items');
    expect(phone.storefrontUpdatedAtCopy('9:41 AM')).toBe('Updated 9:41 AM');
    expect(phone.storefrontQuantityHintCopy(8)).toBe('Up to 8. Enter 0 to remove it from your cart.');
    expect(phone.storefrontInCartCopy(2)).toBe('2 in your cart');
    expect(phone.kitComponentLineCopy(2, 'Backpack')).toBe('2 × Backpack');
    expect(phone.kitsInCartCopy(1)).toBe('1 kit in your cart');
    expect(phone.kitsInCartCopy(3)).toBe('3 kits in your cart');
    expect(phone.checkoutNotesCounterCopy(1850, 2000)).toBe('1,850 / 2,000');
    expect(phone.checkoutNotesCounterCopy(12, 2000)).toBe('12 / 2,000');
    expect(phone.successEmailButtonCopy('pickup')).toBe('Email pickup request');
    expect(phone.successEmailButtonCopy('delivery')).toBe('Email delivery request');
    expect(phone.signOutUnconfirmedOrdersCopy(1)).toBe('1 order request was sent but not confirmed.');
    expect(phone.signOutUnconfirmedOrdersCopy(2)).toBe('2 order requests were sent but not confirmed.');
    expect(phone.signInHeldPlacedCopy('SO-000123')).toBe('Your order request SO-000123 was placed.');
    expect(phone.signInHeldPlacedCopy(null)).toBe('Your order request was placed.');
  });

  it('the stock notice names each line once, in the plan’s words', () => {
    expect(phone.checkoutStockChangedCopy([{ name: 'Planner', available: 8, quantity: 10 }])).toBe(
      'Stock changed since you added: Planner now has 8 available, and you have 10.',
    );
    expect(
      phone.checkoutStockChangedCopy([
        { name: 'Planner', available: 8, quantity: 10 },
        { name: 'Mug', available: 0, quantity: 2 },
      ]),
    ).toBe(
      'Stock changed since you added: Planner now has 8 available, and you have 10; Mug now has 0 available, and you have 2.',
    );
  });

  it('the restored-cart notice says what changed, and nothing when nothing did', () => {
    expect(phone.restoredCartChangedCopy({ notOrderable: 0, overAvailable: 0 })).toBeNull();
    expect(phone.restoredCartChangedCopy({ notOrderable: 1, overAvailable: 0 })).toBe(
      "Since this cart was saved, 1 item can't be ordered from here anymore. They are marked below.",
    );
    expect(phone.restoredCartChangedCopy({ notOrderable: 2, overAvailable: 1 })).toBe(
      "Since this cart was saved, 2 items can't be ordered from here anymore, and 1 line asks for more than is available now. They are marked below.",
    );
    expect(phone.restoredCartChangedCopy({ notOrderable: 0, overAvailable: 3 })).toBe(
      'Since this cart was saved, 3 lines ask for more than is available now. They are marked below.',
    );
  });

  it('no name here repeats a name copy.ts already exports', () => {
    for (const name of Object.keys(phone)) expect(Object.keys(copy)).not.toContain(name);
  });
});

describe('the words rules (plan section 6)', () => {
  const sentences: string[] = [
    ...(Object.values(phone) as unknown[]).filter((v): v is string => typeof v === 'string'),
    phone.storefrontSeeAllCopy(3),
    phone.storefrontUpdatedAtCopy('9:41 AM'),
    phone.storefrontQuantityHintCopy(4),
    phone.checkoutStockChangedCopy([{ name: 'Planner', available: 8, quantity: 10 }]),
    phone.restoredCartChangedCopy({ notOrderable: 1, overAvailable: 1 })!,
    phone.successEmailButtonCopy('pickup'),
    phone.signOutUnconfirmedOrdersCopy(1),
    phone.signInHeldPlacedCopy('SO-000001'),
  ];

  it('has the sentences this guard walks', () => {
    expect(sentences.length).toBeGreaterThanOrEqual(60);
  });

  it('no sentence carries a uuid, a snake_case token or an emoji', () => {
    for (const s of sentences) {
      expect(s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(s).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('no sentence says "book" for a quantity, "sent" for an email draft, or "try again"', () => {
    for (const s of sentences) {
      expect(s).not.toMatch(/\bbook\b/i);
      expect(s).not.toMatch(/email (was )?sent|sent the email/i);
      expect(s).not.toMatch(/try again/i);
    }
  });
});

describe('importing phone-copy.ts runs nothing', () => {
  it('has no call, new or tagged template at its top level', () => {
    const file = path.join(HERE, 'phone-copy.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n)) {
        found.push(n.getText(sf).slice(0, 60));
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
      visit(st);
    }
    expect(found).toEqual([]);
  });

  it('core’s index exports it', () => {
    const index = readFileSync(path.join(HERE, '../../index.ts'), 'utf8');
    expect(index).toContain("export * from './orders/storefront/phone-copy';");
  });
});
