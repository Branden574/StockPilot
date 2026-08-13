/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A RENAME MUST NOT STRIP A CRATE'S POSITION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A crate's rack is carried by its NAME — "Gray #BIN on rack 43-B" — because
 * that is what makes migration 0270's `lower(name)` index keep five real "gray
 * BIN" bins as five rows (locations.crateIdentity.test.ts pins that half). The
 * `rack_number`/`rack_row` columns hold the same pair, but NOTHING that renders
 * a placement reads them: a holding reaches every formatter as
 * `{ name, quantity, kind }` and nothing more.
 *
 * So a crate whose columns say 43-B and whose NAME has lost the suffix has
 * quietly stopped sitting on a rack EVERYWHERE AT ONCE — pick slip, packing
 * slip, count sheet, count picker, rental catalog, inventory table, item card,
 * three native screens. No write path produces that shape: `create` composes
 * the name through `formatCrateLocationName`, and `update` cannot touch the
 * columns at all. A RENAME is the one way in, and it was unguarded.
 *
 * REFUSE rather than regenerate: regenerating discards what the operator typed,
 * and cannot be right in the case they most plausibly meant (retyping the
 * position to MOVE the crate — the columns would still say 43-B afterwards).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});

import { LocationsService } from './locations';
import { ServiceError } from './context';

const ID = 'loc-1';

/** Run `update` against one existing `locations` row. */
async function rename(
  row: { kind: string | null; rack_number: string | null; rack_row: string | null },
  patch: Record<string, unknown>,
) {
  const stub = makeSupabaseStub({
    'locations.select': { data: row, error: null },
    'locations.update': { data: { id: ID }, error: null },
  });
  const svc = new LocationsService(makeServiceContext(stub.client));
  const result = await svc
    .update(ID, patch as never)
    .then((d) => ({ ok: true as const, data: d }))
    .catch((e: unknown) => ({ ok: false as const, error: e }));
  return { result, wrote: stub.chainArgs.get('locations.update')?.[0]?.[0] };
}

const POSITIONED = { kind: 'crate', rack_number: '43', rack_row: 'B' };

beforeEach(() => vi.clearAllMocks());

describe('renaming a POSITIONED crate', () => {
  it('REFUSES a name that drops the position, and writes nothing', async () => {
    const { result, wrote } = await rename(POSITIONED, { name: 'Gray BIN' });
    expect(result.ok).toBe(false);
    const error = (result as { error: unknown }).error;
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('validation_error');
    expect((error as ServiceError).message).toContain('43-B');
    // Fails CLOSED: `.update().eq()` fails open in this codebase, so the guard
    // has to run BEFORE the write, not alongside it.
    expect(wrote).toBeUndefined();
  });

  it('REFUSES a rename that retypes a DIFFERENT rack — moving a crate is a put-away', async () => {
    const { result } = await rename(POSITIONED, { name: 'Gray #BIN on rack 41-C' });
    expect(result.ok).toBe(false);
    // The columns would still say 43-B afterwards, so accepting this would
    // create exactly the name/column disagreement the guard exists to stop.
    expect(((result as { error: ServiceError }).error).message).toContain('43-B');
  });

  it('ALLOWS a rename that keeps the position', async () => {
    const { result, wrote } = await rename(POSITIONED, { name: 'Grey #BIN on rack 43-B' });
    expect(result.ok).toBe(true);
    expect(wrote).toEqual({ name: 'Grey #BIN on rack 43-B' });
  });

  it('tolerates the legacy rack SHAPE in the typed suffix', async () => {
    const { result } = await rename(POSITIONED, { name: 'Gray #BIN on rack 43 - b' });
    expect(result.ok).toBe(true);
  });

  it('leaves a NON-name patch alone — no read, no refusal', async () => {
    const { result, wrote } = await rename(POSITIONED, { notes: 'top shelf' });
    expect(result.ok).toBe(true);
    expect(wrote).toEqual({ notes: 'top shelf' });
  });
});

describe('everything else renames freely', () => {
  it('a POSITION-LESS crate has no position to lose', async () => {
    // The permanent, backward-compatible shape — every crate in production
    // today was created this way. Never backfilled, never guarded.
    const { result } = await rename(
      { kind: 'crate', rack_number: null, rack_row: null },
      { name: 'Blue Shelf' },
    );
    expect(result.ok).toBe(true);
  });

  it("a RACK renames freely — its name IS its label, so nothing silently disagrees", async () => {
    const { result } = await rename(
      { kind: 'rack', rack_number: '43', rack_row: 'B' },
      { name: 'Aisle 3' },
    );
    expect(result.ok).toBe(true);
  });

  it('a SITE (kind NULL — never backfill it) renames freely', async () => {
    const { result } = await rename(
      { kind: null, rack_number: null, rack_row: null },
      { name: 'DC4 North' },
    );
    expect(result.ok).toBe(true);
  });
});
