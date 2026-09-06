import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the mobile rental checkout screen (SP-012).
 *
 * THE BUG THIS GUARDS: app/rentals/new.tsx writes a `rentals` header row
 * STRAIGHT TO THE TABLE — no rental_lines, no stock_reservations, no
 * availability guard, no audit row, no checkout email — while its own
 * docstring claimed it was "the same insert path the web's RentalCheckoutForm
 * uses". That component does not exist; the web path is RentalsService.create
 * (apps/web/src/server/services/rentals.ts), which asserts `rentals:create`,
 * refuses non-rental items, refuses over-lending (SP-052) and reserves stock
 * through a service-role client because stock_reservations is service-role
 * only (migs 0119/0263). A false parity claim in a comment is worse than no
 * comment: it is why nobody questioned the header-only insert.
 *
 * Two properties are pinned here until the real fix lands (an /api/v1/rentals
 * Bearer twin over RentalsService + an item picker on this screen):
 *   1. the file must not re-assert web parity, and must name what it skips;
 *   2. the screen must re-check `rentals:create` itself. The '+' on the list
 *      (src/screens/rentals.tsx) is gated, but this route is reachable
 *      directly, and unlike every other mobile write there is NO server gate
 *      behind it — RLS 0131 checks warehouse write access only, never the
 *      configurable permission.
 *
 * WHY SOURCE-LEVEL PINS: the screen lives under app/, which the mobile vitest
 * config deliberately excludes from collection (native imports at module
 * scope), so nothing else can observe these properties. Same idiom as
 * bundle-distribute-wiring.test.ts: read the real source, assert the property.
 */

const SCREEN = path.resolve(__dirname, '../../app/rentals/new.tsx');
const source = readFileSync(SCREEN, 'utf8');

/** Everything above the component — the file's docstring/header comment. */
function header(): string {
  const end = source.indexOf('export default function NewRental');
  expect(end, 'NewRental component not found').toBeGreaterThan(-1);
  return source.slice(0, end);
}

/** The submit() body: its declaration through the closing of the function. */
function submitBody(): string {
  const start = source.indexOf('async function submit()');
  const end = source.indexOf('\n  }', start);
  expect(start, 'submit() not found').toBeGreaterThan(-1);
  expect(end, 'end of submit() not found').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('rentals/new.tsx — scope honesty (SP-012)', () => {
  it('does not claim to share the web checkout path', () => {
    // `RentalCheckoutForm` exists nowhere in the repo, and the web path runs
    // eight things this screen does not. Claiming parity hid the divergence.
    expect(source).not.toMatch(/RentalCheckoutForm/);
    expect(source).not.toMatch(/same insert path/i);
  });

  it('names the guards the direct insert skips, so the next reader is not misled', () => {
    const h = header();
    expect(h, 'header must say no rental_lines are written').toMatch(/rental_lines/);
    expect(h, 'header must say stock is not reserved').toMatch(/reserv/i);
    expect(h, 'header must point at the route that would fix it').toMatch(/api\/v1\/rentals/);
  });

  it('tells the operator on screen that the asset is not reserved', () => {
    const jsx = source.slice(source.indexOf('return ('));
    expect(jsx).toMatch(/reserve/i);
  });
});

describe('rentals/new.tsx — rentals:create gate (SP-012)', () => {
  it('re-checks rentals:create on the screen itself, not only on the list CTA', () => {
    expect(source).toMatch(/useEffectivePermissions/);
    expect(source).toMatch(/showWriteCta\(\s*perms,\s*'rentals:create'\s*\)/);
  });

  it('refuses to insert when the permission is absent', () => {
    const body = submitBody();
    const guard = body.search(/if \(!canCreate\)/);
    const insert = body.indexOf("supabase.from('rentals').insert");
    expect(guard, 'submit() must guard on canCreate').toBeGreaterThan(-1);
    expect(insert, 'the direct insert must still be found').toBeGreaterThan(-1);
    expect(guard, 'the guard must come BEFORE the insert').toBeLessThan(insert);
  });

  it('disables the Check out button without the permission', () => {
    const canSubmit = source.slice(source.indexOf('const canSubmit ='));
    expect(canSubmit.slice(0, canSubmit.indexOf(';'))).toMatch(/canCreate/);
  });
});
