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
    // Spoken (PO-4 review): "1,850 / 2,000" read aloud is a slash.
    expect(phone.checkoutNotesCounterSpokenCopy(1850, 2000)).toBe('1,850 of 2,000 characters');
    expect(phone.CHECKOUT_NOTES_FULL_COPY).toBe("That's the most a note can hold.");
    expect(phone.successEmailButtonCopy('pickup')).toBe('Email pickup request');
    expect(phone.successEmailButtonCopy('delivery')).toBe('Email delivery request');
    // PO-4 review: the confirmation names the order's own method (a pickup's
    // said "delivery request"), and the app that opened the draft.
    expect(phone.successEmailOpenedCopy('pickup', false)).toBe(
      'Outlook opened a draft of your pickup request. Review the message and press Send yourself.',
    );
    expect(phone.successEmailOpenedCopy('delivery', true)).toBe(
      'Your email app opened a draft of your delivery request. Review the message and press Send yourself.',
    );
    expect(phone.signOutUnconfirmedOrdersCopy(1)).toBe('1 order request was sent but not confirmed.');
    expect(phone.signOutUnconfirmedOrdersCopy(2)).toBe('2 order requests were sent but not confirmed.');
    expect(phone.signInHeldPlacedCopy('SO-000123')).toBe('Your order request SO-000123 was placed.');
    expect(phone.signInHeldPlacedCopy(null)).toBe('Your order request was placed.');
    expect(phone.checkoutNeededByZoneUnknownCopy('Asia/Kolkata')).toBe(
      "This phone can't show times in Asia/Kolkata, so a needed-by date can't be chosen here. You can still place the order.",
    );
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

  // PO-4 review: "marked below" pointed nowhere on the iPhone home (the lines
  // are in the cart sheet) or the iPad (the column beside): direction-free.
  it('the restored-cart notice says what changed, and nothing when nothing did', () => {
    expect(phone.restoredCartChangedCopy({ notOrderable: 0, overAvailable: 0 })).toBeNull();
    expect(phone.restoredCartChangedCopy({ notOrderable: 1, overAvailable: 0 })).toBe(
      "Since this cart was saved, 1 item can't be ordered from here anymore. It is marked in your cart.",
    );
    // Simulator walk D8: one change is "It", never "They".
    expect(phone.restoredCartChangedCopy({ notOrderable: 0, overAvailable: 1 })).toBe(
      'Since this cart was saved, 1 line asks for more than is available now. It is marked in your cart.',
    );
    expect(phone.restoredCartChangedCopy({ notOrderable: 1, overAvailable: 1 })).toBe(
      "Since this cart was saved, 1 item can't be ordered from here anymore, and 1 line asks for more than is available now. They are marked in your cart.",
    );
    expect(phone.restoredCartChangedCopy({ notOrderable: 2, overAvailable: 1 })).toBe(
      "Since this cart was saved, 2 items can't be ordered from here anymore, and 1 line asks for more than is available now. They are marked in your cart.",
    );
    expect(phone.restoredCartChangedCopy({ notOrderable: 1, overAvailable: 0 })).not.toMatch(/below|above/);
    expect(phone.restoredCartChangedCopy({ notOrderable: 0, overAvailable: 3 })).toBe(
      'Since this cart was saved, 3 lines ask for more than is available now. They are marked in your cart.',
    );
  });

  // PO-4 review: the For sheet's footer action reads as the sheet's confirm,
  // but Myself and a recent person apply on tap: it names someone new; and a
  // search that matched nobody is not "Nobody yet".
  it('the Orders list’s words (PO-4 review)', () => {
    expect(phone.ORDERS_LIST_EMPTY_TITLE_COPY).toBe('No orders yet.');
    expect(phone.ORDERS_LIST_EMPTY_BODY_COPY).toBe('When someone requests inventory from one of your warehouses, the request lands here.');
    expect(phone.ORDERS_LIST_EMPTY_OWN_BODY_COPY).toBe('The order requests you place show here.');
    expect(phone.ORDERS_LIST_RELOAD_FAILED_COPY).toBe("Orders couldn't be loaded again, so these may be out of date. Pull down to load them again.");
  });

  // PO-4 review: the filter chips' way out sat beside the cart's own "Clear
  // all" in the iPad split view; the screens' last literals become core's.
  it('the polish words', () => {
    expect(phone.STOREFRONT_CLEAR_FILTERS_COPY).toBe('Clear all filters');
    expect(phone.STOREFRONT_BACK_COPY).toBe('Back');
    expect(phone.STOREFRONT_NONE_COPY).toBe('None');
    expect(phone.SUCCESS_EMAIL_OPEN_ANOTHER_TITLE_COPY).toBe('Open another draft?');
    expect(phone.SUCCESS_EMAIL_OPEN_ANOTHER_COPY).toBe('Open another draft');
    expect(phone.SUCCESS_EMAIL_COPY_FIELD_LABEL_COPY).toBe('Request text to copy');
  });

  it('the For sheet’s words', () => {
    expect(phone.CHECKOUT_USE_PERSON_COPY).toBe('Order for someone new');
    expect(phone.CHECKOUT_REQUESTERS_NO_MATCH_COPY).toBe('Nobody matches that. Enter someone new.');
  });

  it('the on-behalf sentence starts with the server refusal’s words (slice D)', async () => {
    const { ORDER_ON_BEHALF_NOT_PERMITTED_COPY } = await import('../place-order');
    expect(phone.SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY.startsWith(ORDER_ON_BEHALF_NOT_PERMITTED_COPY)).toBe(true);
  });

  it('the sign-in prompt never promises it is never placed (it may already have been)', () => {
    expect(phone.SIGN_IN_HELD_UNCONFIRMED_COPY).not.toMatch(/never placed/);
    expect(phone.SIGN_IN_HELD_UNCONFIRMED_COPY).toBe(
      "An order request you sent before signing out still isn't confirmed. Choose Don't send it to stop it if it hasn't been placed yet, or see your orders.",
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
    phone.checkoutNotesCounterSpokenCopy(1800, 2000),
    phone.successEmailOpenedCopy('pickup', false),
    phone.successEmailOpenedCopy('delivery', true),
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
