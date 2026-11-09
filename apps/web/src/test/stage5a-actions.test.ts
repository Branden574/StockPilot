import { describe, expect, it } from 'vitest';

import allowlistJson from '../../tests/e2e/appearance/glass-only-allowlist.json';
import {
  compareInventories,
  disclosuresToPress,
  menusToOpen,
  parseAction,
  routeMatches,
  textPattern,
  TWIN_RULES,
  type Allowlist,
} from '../../tests/e2e/appearance/stage5a-actions';

/**
 * The plan 8.5 action-inventory rule that action-inventory.spec.ts applies
 * on the lab, proved on hand-written inventories against the real
 * glass-only-allowlist.json.
 */

const ALLOWLIST = allowlistJson as unknown as Allowlist;
const WIDE = 1440;

const link = (name: string, to: string) => `link ${JSON.stringify(name)} -> ${to}`;
const button = (name: string) => `button ${JSON.stringify(name)}`;

const SHELL_CLASSIC = [
  link('Orders', '/dashboard/orders'),
  link('Reports', '/dashboard/reports'),
  button('Toggle theme'),
  button('What’s new'),
  link('StockPilot home', '/'),
].sort();

describe('stage 5 action inventory rule', () => {
  it('reads actionsOf entries back', () => {
    expect(parseAction(link('Open the report', '/dashboard/reports/book-order-totals'))).toEqual({
      role: 'link',
      name: 'Open the report',
      target: '/dashboard/reports/book-order-totals',
      raw: link('Open the report', '/dashboard/reports/book-order-totals'),
    });
    expect(parseAction(button('Say "hi"'))).toMatchObject({
      role: 'button',
      name: 'Say "hi"',
      target: null,
    });
  });

  it('matches allowlist routes: [x] one segment, /** below, exact otherwise', () => {
    expect(routeMatches('/dashboard/**', '/dashboard/inventory/abc')).toBe(true);
    expect(routeMatches('/dashboard/**', '/dashboard')).toBe(false);
    expect(routeMatches('/dashboard/orders/[id]', '/dashboard/orders/abc')).toBe(true);
    expect(routeMatches('/dashboard/orders/[id]', '/dashboard/orders/abc/edit')).toBe(false);
    expect(routeMatches('/signin', '/signin/')).toBe(true);
    expect(textPattern('Scroll to cart, <n> units').test('Scroll to cart, 12 units')).toBe(true);
    expect(textPattern('/dashboard/orders/<id>').test('/dashboard/orders/x/y')).toBe(false);
  });

  it('passes identical inventories and counts the renamed menu trigger as its classic name', () => {
    const glass = SHELL_CLASSIC.map((a) =>
      a === button('Toggle theme') ? button('Appearance: design and theme') : a,
    );
    expect(
      compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, { path: '/dashboard', width: WIDE }),
    ).toEqual({
      extraInGlass: [],
      missingInGlass: [],
      allowed: [],
    });
  });

  it('fails a glass-only action the allowlist does not name, and a classic action glass lost', () => {
    const glass = [
      ...SHELL_CLASSIC.filter((a) => a !== link('Reports', '/dashboard/reports')),
      button('Delete everything'),
    ];
    const diff = compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, {
      path: '/dashboard/inventory',
      width: WIDE,
    });
    expect(diff.extraInGlass).toEqual([button('Delete everything')]);
    expect(diff.missingInGlass).toEqual([link('Reports', '/dashboard/reports')]);
  });

  it('allows a listed duplicate only with its classic twin for this role', () => {
    const glass = [...SHELL_CLASSIC, link('Place an order', '/dashboard/orders/new')];
    const ok = compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, {
      path: '/dashboard/inventory',
      width: WIDE,
    });
    expect(ok.extraInGlass).toEqual([]);
    expect(ok.allowed).toEqual([
      `${link('Place an order', '/dashboard/orders/new')} [sidebar-place-an-order]`,
    ]);

    // A role without the Orders entry in Classic: the glass duplicate has no twin.
    const classicNoOrders = SHELL_CLASSIC.filter((a) => a !== link('Orders', '/dashboard/orders'));
    const glassNoOrders = [...classicNoOrders, link('Place an order', '/dashboard/orders/new')];
    const bad = compareInventories(classicNoOrders, glassNoOrders, ALLOWLIST, {
      path: '/dashboard/inventory',
      width: WIDE,
    });
    expect(bad.extraInGlass).toHaveLength(1);
    expect(bad.extraInGlass[0]).toContain('classic twin');
  });

  it('fails a listed duplicate or public page link that goes anywhere but its twin’s target', () => {
    const cases: Array<{ path: string; classic: string[]; glass: string; right: string }> = [
      {
        path: '/dashboard',
        classic: SHELL_CLASSIC,
        glass: link('Place an order', '/dashboard/settings/roles'),
        right: link('Place an order', '/dashboard/orders/new'),
      },
      {
        path: '/signin',
        classic: [link('StockPilot home', '/'), button('Sign in')].sort(),
        glass: link('Contact the team', 'https://evil.example.com/collect'),
        right: link('Contact the team', '/contact'),
      },
      {
        path: '/signin',
        classic: [link('StockPilot home', '/'), button('Sign in')].sort(),
        glass: link('Security', '/dashboard/settings'),
        right: link('Security', '/security'),
      },
      {
        path: '/dashboard/books/abc',
        classic: SHELL_CLASSIC,
        glass: link('Open the report', '/dashboard/reports/stock-value'),
        right: link('Open the report', '/dashboard/reports/book-order-totals'),
      },
      {
        // A link without a target is never the twin's link.
        path: '/dashboard',
        classic: SHELL_CLASSIC,
        glass: button('Place an order'),
        right: link('Place an order', '/dashboard/orders/new'),
      },
    ];
    for (const c of cases) {
      const at = { path: c.path, width: WIDE };
      const wrong = compareInventories(c.classic, [...c.classic, c.glass], ALLOWLIST, at);
      expect(wrong.allowed, c.glass).toEqual([]);
      expect(wrong.extraInGlass, c.glass).toHaveLength(1);
      expect(wrong.extraInGlass[0], c.glass).toContain(c.glass);
      const right = compareInventories(c.classic, [...c.classic, c.right], ALLOWLIST, at);
      expect(right.extraInGlass, c.right).toEqual([]);
      expect(right.allowed, c.right).toHaveLength(1);
    }
  });

  it('every twin rule’s target is the href its allowlist entry’s selector names, where it names one', () => {
    for (const entry of ALLOWLIST.entries) {
      const rule = TWIN_RULES[entry.id];
      if (!rule) continue;
      expect(rule.target, entry.id).toMatch(/^\//u);
      const named = /href="([^"]+)"/u.exec(entry.selector ?? '')?.[1] ?? entry.href;
      if (named) expect(rule.target, entry.id).toBe(named);
    }
  });

  it('allows a listed action only on its routes', () => {
    const glass = [...SHELL_CLASSIC, button('Choose more columns')];
    expect(
      compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, { path: '/dashboard/books', width: WIDE })
        .extraInGlass,
    ).toEqual([]);
    expect(
      compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, {
        path: '/dashboard/inventory',
        width: WIDE,
      }).extraInGlass,
    ).toEqual([button('Choose more columns')]);
  });

  it('auth pages: the glass Contact link needs the classic home link', () => {
    const classic = [link('StockPilot home', '/'), button('Sign in')].sort();
    const glass = [...classic, link('Contact the team', '/contact')];
    expect(
      compareInventories(classic, glass, ALLOWLIST, { path: '/signin', width: WIDE }).extraInGlass,
    ).toEqual([]);
    const noHome = [button('Sign in')];
    expect(
      compareInventories(noHome, [...noHome, link('Contact the team', '/contact')], ALLOWLIST, {
        path: '/signin',
        width: WIDE,
      }).extraInGlass,
    ).toHaveLength(1);
  });

  it('at phone width: What’s new may move into the account menu only when the menu holds it', () => {
    const at = { path: '/dashboard/inventory', width: 390 };
    const glass = SHELL_CLASSIC.filter((a) => a !== button('What’s new')).map((a) =>
      a === button('Toggle theme') ? button('Appearance: design and theme') : a,
    );
    expect(menusToOpen(ALLOWLIST, at).map((e) => e.id)).toEqual(['account-menu-whats-new']);
    expect(
      compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, at, ['menuitem "What’s new"'])
        .missingInGlass,
    ).toEqual([]);
    expect(compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, at, []).missingInGlass).toEqual([
      button('What’s new'),
    ]);
    // Wide: the move does not apply, the classic button must be there.
    expect(
      compareInventories(SHELL_CLASSIC, glass, ALLOWLIST, { ...at, width: WIDE }, [
        'menuitem "What’s new"',
      ]).missingInGlass,
    ).toEqual([button('What’s new')]);
  });

  it('at phone width on Orders: the order links may be replaced by card links to the same order', () => {
    const order = '/dashboard/orders/0d3c2b1a-0000-4000-8000-000000000001';
    const classic = [link('SO-000231', order), link('Lab Requester', order)].sort();
    const glass = [link('SO-000231 Lab Requester 3 lines', order)];
    const at = { path: '/dashboard/orders', width: 390 };
    expect(compareInventories(classic, glass, ALLOWLIST, at)).toMatchObject({
      extraInGlass: [],
      missingInGlass: [],
    });
    expect(
      compareInventories(classic, glass, ALLOWLIST, { ...at, width: WIDE }).extraInGlass,
    ).toHaveLength(1);
  });

  it('names the disclosures to press on an item page, and every twin rule names an allowlist entry', () => {
    expect(
      disclosuresToPress(ALLOWLIST, { path: '/dashboard/inventory/abc', width: WIDE }).map(
        (e) => e.id,
      ),
    ).toEqual(['item-more-actions']);
    const ids = new Set(ALLOWLIST.entries.map((e) => e.id));
    for (const id of Object.keys(TWIN_RULES)) expect(ids.has(id), id).toBe(true);
    for (const entry of ALLOWLIST.entries.filter(
      (e) =>
        (e.kind === 'duplicate action' || e.kind.startsWith('public page link')) &&
        e.role &&
        e.name,
    )) {
      expect(TWIN_RULES[entry.id], `a twin rule for ${entry.id}`).toBeDefined();
    }
  });
});
