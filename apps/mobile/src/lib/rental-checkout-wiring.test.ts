import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for the mobile rental checkout screen (SP-012).
 *
 * THE BUG THIS GUARDS: app/rentals/new.tsx used to write a `rentals` header row
 * STRAIGHT TO THE TABLE — no rental_lines, no stock_reservations, no
 * availability guard, no audit row, no checkout email — while its own docstring
 * claimed it was "the same insert path the web's RentalCheckoutForm uses". That
 * component does not exist; the web path is RentalsService.create
 * (apps/web/src/server/services/rentals.ts), which asserts `rentals:create`,
 * refuses non-rental items, refuses over-lending (SP-052) and reserves stock
 * through a service-role client because stock_reservations is service-role only
 * (migs 0119/0263). RLS 0131 gates rentals_insert on warehouse write access
 * ALONE, so nothing ever refused the header-only row.
 *
 * WHAT CHANGED (this wave): the Bearer twin now exists at
 * apps/web/src/app/api/v1/rentals/route.ts, so the screen POSTs there and the
 * service runs in full. These pins were previously written the other way round
 * — they PINNED the direct insert as "still found", deliberately, so the
 * divergence could not be deepened while the route was missing. That interim
 * contract is over; the pins are inverted rather than deleted so the file still
 * records why the insert existed and why it must never come back.
 *
 * WHY SOURCE-LEVEL PINS: the screen lives under app/, which the mobile vitest
 * config deliberately excludes from collection (native imports at module
 * scope), so nothing else can observe these properties. Same idiom as
 * bundle-distribute-wiring.test.ts: read the real source, assert the property.
 */

const SCREEN = path.resolve(__dirname, '../../app/rentals/new.tsx');
const source = readFileSync(SCREEN, 'utf8');

/**
 * The source with every comment stripped. The "no direct table write" pins MUST
 * run against this: the header docstring deliberately QUOTES the old
 * `supabase.from('rentals').insert(...)` line so the next reader knows what was
 * removed and why, and a naive whole-file grep would read that explanation as
 * the offence itself.
 */
function code(): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Everything above the component — the file's docstring/header comment. */
function header(): string {
  const end = source.indexOf('export default function NewRental');
  expect(end, 'NewRental component not found').toBeGreaterThan(-1);
  return source.slice(0, end);
}

/** The submit() body, from its declaration to the next top-level declaration. */
function submitBody(): string {
  const start = source.indexOf('async function submit()');
  expect(start, 'submit() not found').toBeGreaterThan(-1);
  const end = source.indexOf('\n  return (', start);
  expect(end, 'end of submit() not found').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('rentals/new.tsx — goes through the service, not the table (SP-012)', () => {
  it('never writes the rentals table directly again', () => {
    // A direct insert can never write rental_lines' sibling reservations:
    // stock_reservations is service-role only (0119/0263), so the asset stays
    // available-to-promise and a second borrower can be handed the same unit.
    const src = code();
    expect(src).not.toMatch(/from\(\s*'rentals'\s*\)\s*\.?\s*\n?\s*\.insert/);
    expect(src).not.toMatch(/from\(\s*'rental_lines'\s*\)/);
    // Nor may it try to reserve from the device — RLS refuses, and a swallowed
    // refusal would look exactly like success (recurring pattern #28).
    expect(src).not.toMatch(/from\(\s*'stock_reservations'\s*\)\s*\.?\s*\n?\s*\.insert/);
  });

  it('POSTs the checkout to the /api/v1/rentals Bearer twin', () => {
    const body = submitBody();
    expect(body, 'submit() must call the shared api() client').toMatch(/api</);
    expect(body).toMatch(/'\/api\/v1\/rentals'/);
    expect(body).toMatch(/method:\s*'POST'/);
  });

  it('sends at least one line, because a line-less rental reserves nothing', () => {
    const body = submitBody();
    // `lines,` (shorthand) or `lines: …` — either shape, but it must be there.
    expect(body, 'the POST body must carry lines').toMatch(/\blines\s*[,:]/);
  });

  it('does not claim to share the web checkout path by naming a component that never existed', () => {
    expect(source).not.toMatch(/RentalCheckoutForm/);
    expect(source).not.toMatch(/same insert path/i);
  });

  it('header explains the route and what the service does that a table write cannot', () => {
    const h = header();
    expect(h, 'header must point at the route').toMatch(/api\/v1\/rentals/);
    expect(h, 'header must name rental_lines').toMatch(/rental_lines/);
    expect(h, 'header must name the reservation problem').toMatch(/reserv/i);
  });
});

describe('rentals/new.tsx — item selection (SP-012)', () => {
  it('picks real rental items rather than free-text notes', () => {
    // createRentalSchema requires lines.min(1); a notes-only screen cannot
    // satisfy it, and a rental with no lines is the original defect.
    expect(source).toMatch(/is_rental/);
    expect(source).toMatch(/inventory_items/);
  });

  it('reads open reservations so availability shown matches what the server enforces', () => {
    // Server-side truth is quantity_on_hand - open reservations (SP-052). If
    // the phone showed on-hand it would offer units the route then refuses.
    // The read lives in the shared, batched reader (up to 500 ids here, far
    // past one `.in()` URL); the reader holds the table and the open filter.
    expect(code()).toMatch(/readOpenReservations\(\s*supabase,\s*orgId,/);
    const reader = readFileSync(path.resolve(__dirname, 'id-reads.ts'), 'utf8');
    expect(reader).toMatch(/idReadTable\(client, 'stock_reservations'\)/);
    expect(reader).toMatch(/\.is\('released_at', null\)/);
  });
});

/** The body of the effect that loads the items and their reservations. */
function itemsEffect(): string {
  const start = source.indexOf('if (!orgId || !warehouseId) return;');
  expect(start, 'items effect not found').toBeGreaterThan(-1);
  const end = source.indexOf('}, [orgId, warehouseId, itemsNonce]);', start);
  expect(end, 'items effect deps not found (a retry must re-run it)').toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The body of the effect that loads the warehouses. */
function warehousesEffect(): string {
  const start = source.indexOf(".from('warehouses')");
  expect(start).toBeGreaterThan(-1);
  const open = source.lastIndexOf('React.useEffect(', start);
  const end = source.indexOf('}, [orgId, warehousesNonce]);', start);
  expect(end, 'warehouses effect deps not found (it needs its own retry)').toBeGreaterThan(start);
  return source.slice(open, end);
}

describe('rentals/new.tsx — a failed read blocks the picker, never reads as available', () => {
  it('a failed reservations read sets a blocking error, never "nothing reserved"', () => {
    const body = itemsEffect();
    expect(body).toMatch(
      /if \(reservations\.ok\) \{\s*setReservedByItem\(Object\.fromEntries\(sumReservedByItem\(reservations\.value\)\)\);\s*\} else \{[\s\S]*?setStockError\(reservations\.message\);/,
    );
  });

  it('a failed items read sets its own error instead of "No rental items in this warehouse"', () => {
    const body = itemsEffect();
    expect(body).toContain('const { data, error } = await supabase');
    expect(body).toMatch(/if \(error\) \{[\s\S]*?setItemsError\(error\.message\);[\s\S]*?return;/);
  });

  it('every items load clears both flags before its first read', () => {
    const body = itemsEffect();
    const firstAwait = body.indexOf('await ');
    expect(body.slice(0, firstAwait)).toContain('setItemsError(null);');
    expect(body.slice(0, firstAwait)).toContain('setStockError(null);');
  });

  it('the warehouses read binds its error, clears it on every load, and can be retried', () => {
    const body = warehousesEffect();
    const firstAwait = body.indexOf('await ');
    expect(body.slice(0, firstAwait)).toContain('setWarehousesError(null);');
    expect(body).toMatch(/if \(error\) \{[\s\S]*?setWarehousesError\(error\.message\);/);
    expect(source).toContain('onRetry={() => setWarehousesNonce((n) => n + 1)}');
    expect(source).toContain('No active warehouses to check out from. Add one on the web first.');
  });

  it('Check out is disabled and submit() refuses while the picker is blocked', () => {
    expect(source).toContain('const picker = rentalPickerStatus({ warehousesError, itemsError, stockError });');
    const canSubmit = source.slice(source.indexOf('const canSubmit ='));
    expect(canSubmit.slice(0, canSubmit.indexOf(';'))).toMatch(/!picker\.blocked/);
    const body = submitBody();
    const guard = body.indexOf('if (picker.blocked || itemsLoading) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("'/api/v1/rentals'"));
  });

  it('a blocked picker renders the failure and a retry, not the list or its steppers', () => {
    const jsx = source.slice(source.indexOf('return (\n    <View'));
    const blocked = jsx.indexOf(') : picker.blocked ? (');
    const list = jsx.indexOf('visibleItems.map(');
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(list);
    expect(jsx).toContain('onRetry={() => setItemsNonce((n) => n + 1)}');
    // The retry button is disabled while its reload runs.
    expect(source).toMatch(/onPress=\{onRetry\}\s*disabled=\{retrying\}/);
  });
});

describe('rentals/new.tsx — rentals:create gate (SP-012)', () => {
  it('re-checks rentals:create on the screen itself, not only on the list CTA', () => {
    expect(source).toMatch(/useEffectivePermissions/);
    expect(source).toMatch(/showWriteCta\(\s*perms,\s*'rentals:create'\s*\)/);
  });

  it('refuses to submit when the permission is absent, before the POST', () => {
    const body = submitBody();
    const guard = body.search(/if \(!canCreate\)/);
    const post = body.indexOf("'/api/v1/rentals'");
    expect(guard, 'submit() must guard on canCreate').toBeGreaterThan(-1);
    expect(post, 'the POST must be found').toBeGreaterThan(-1);
    expect(guard, 'the guard must come BEFORE the POST').toBeLessThan(post);
  });

  it('disables the Check out button without the permission', () => {
    const canSubmit = source.slice(source.indexOf('const canSubmit ='));
    expect(canSubmit.slice(0, canSubmit.indexOf(';'))).toMatch(/canCreate/);
  });
});

describe('rentals/new.tsx — refusals are shown, not swallowed (SP-012)', () => {
  it('surfaces the server message on failure', () => {
    // The route can now legitimately REFUSE (over-lend, non-rental item, wrong
    // warehouse) where the direct insert always succeeded. ApiError.message is
    // the service's own operator-readable sentence — show it verbatim.
    const body = submitBody();
    expect(body).toMatch(/ApiError/);
    expect(body).toMatch(/Alert\.alert/);
  });

  it('no longer tells the operator that stock is not reserved — it now is', () => {
    const jsx = source.slice(source.indexOf('return ('));
    expect(jsx).not.toMatch(/does not reserve stock/i);
    expect(jsx).not.toMatch(/stays available to rent elsewhere/i);
  });
});
