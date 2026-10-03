/**
 * ONE FIXTURE, TWO ENGINES (phone ordering plan 3.2 step 3, graft 3), the
 * core side.
 *
 * place-order-parity-cases.json is run by BOTH engines:
 *   - here, parseOrderCreateRequest on each case's body (the generator's
 *     expansion), against `core`;
 *   - in pgTAP (the M1 file PO-2 adds), place_order_request on the p_request
 *     the service would build, against `sql`.
 * The expansion and the SQL block live in scripts/gen-place-order-parity-sql.mjs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  orderCreateRefusalCopy,
  parseOrderCreateRequest,
  type OrderCreateShapeReason,
} from './place-order';
import fixture from './place-order-parity-cases.json';

type CoreExpect = 'accept' | { reason: OrderCreateShapeReason; field?: string };
type SqlExpect = 'accept' | 'unreachable' | { sqlstate: string; hint: string; field?: string };
interface ParityCase {
  id: string;
  title: string;
  body?: Record<string, unknown>;
  sqlPatch?: Record<string, unknown>;
  sqlKey?: string | null;
  core: CoreExpect;
  sql: SqlExpect;
}
interface Fixture {
  ids: Record<string, string>;
  cases: ParityCase[];
}

interface Generator {
  caseBody(fx: unknown, c: ParityCase, n: number): Record<string, unknown>;
  caseSqlRequest(fx: unknown, c: ParityCase, n: number): Record<string, unknown>;
  caseSqlKey(fx: unknown, c: ParityCase, n: number): string | null;
  validateFixture(fx: unknown): void;
  renderPlaceOrderParitySql(fx: unknown): string;
  checkedInBlock(sql: string): string | null;
  consumerFiles(): string[];
  BEGIN_MARKER: string;
  END_MARKER: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fx = fixture as unknown as Fixture;
let gen: Generator;

beforeAll(async () => {
  // A computed path: the generator is plain JavaScript outside this package.
  const url = pathToFileURL(path.join(ROOT, 'scripts/gen-place-order-parity-sql.mjs')).href;
  gen = (await import(/* @vite-ignore */ url)) as Generator;
});

describe('the place-order parity fixture', () => {
  it('says what both engines must answer for every case', () => {
    expect(() => gen.validateFixture(fx)).not.toThrow();
    for (const c of fx.cases) {
      expect(c.core, c.id).toBeDefined();
      expect(c.sql, c.id).toBeDefined();
    }
    // Every shape reason is exercised, and both outcomes on each side.
    const reasons = new Set(fx.cases.flatMap((c) => (c.core === 'accept' ? [] : [c.core.reason])));
    expect([...reasons].sort()).toEqual(
      [
        'delivery_needs_site',
        'invalid',
        'needed_by_invalid_time',
        'notes_too_long',
        'on_behalf_invalid',
        'quantity_not_whole',
        'too_many_lines',
        'too_many_units',
      ].sort(),
    );
    expect(fx.cases.some((c) => c.sql === 'accept')).toBe(true);
    expect(fx.cases.some((c) => c.sql === 'unreachable')).toBe(true);
  });

  it.each(fx.cases.map((c, i) => [c.id, c.title, i + 1] as const))(
    '%s %s: core',
    (_id, _title, n) => {
      const c = fx.cases[n - 1]!;
      const r = parseOrderCreateRequest(gen.caseBody(fx, c, n));
      if (c.core === 'accept') {
        expect(r.ok, JSON.stringify(r)).toBe(true);
        return;
      }
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.refusal.reason).toBe(c.core.reason);
      expect(r.refusal.field).toBe(c.core.field);
      expect(r.refusal.message).toBe(orderCreateRefusalCopy(c.core.reason, c.core.field));
    },
  );

  it('a case the database never sees is one core refuses', () => {
    for (const [i, c] of fx.cases.entries()) {
      if (c.sql !== 'unreachable') continue;
      expect(parseOrderCreateRequest(gen.caseBody(fx, c, i + 1)).ok, c.id).toBe(false);
    }
  });

  it('the database gets the body as the service passes it: kits stay out, the key apart', () => {
    const n = fx.cases.findIndex((c) => c.id === 'A02') + 1;
    const c = fx.cases[n - 1]!;
    const req = gen.caseSqlRequest(fx, c, n);
    expect(Object.keys(req).sort()).toEqual(
      [
        'delivery_charter_id',
        'fulfillment_type',
        'lines',
        'needed_by',
        'notes',
        'on_behalf_email',
        'on_behalf_name',
        'organization_id',
        'placer_user_id',
        'surface',
        'warehouse_id',
      ].sort(),
    );
    expect(req.needed_by).toBe('2026-10-05T10:00:00Z');
    expect(req.surface).toBe('app');
    expect(gen.caseSqlKey(fx, c, n)).toBe(gen.caseBody(fx, c, n).idempotencyKey);
  });

  it('renders the same block every time, one row per case the database sees', () => {
    const a = gen.renderPlaceOrderParitySql(fx);
    expect(gen.renderPlaceOrderParitySql(fx)).toBe(a);
    expect(a.startsWith(gen.BEGIN_MARKER)).toBe(true);
    expect(a.endsWith(gen.END_MARKER)).toBe(true);
    const seen = fx.cases.filter((c) => c.sql !== 'unreachable');
    for (const c of seen) expect(a, c.id).toContain(`'${c.id}'`);
    expect((a.match(/^ {2}\(\d+, '/gm) ?? []).length).toBe(seen.length);
  });

  it('the M1 pgTAP block matches the fixture, once PO-2 adds the file (run node scripts/gen-place-order-parity-sql.mjs)', () => {
    const files = gen.consumerFiles();
    expect(files.length).toBeLessThanOrEqual(1);
    if (files.length === 0) return; // PO-1: the SQL side does not exist yet.
    const block = gen.checkedInBlock(readFileSync(files[0]!, 'utf8'));
    expect(block).not.toBeNull();
    expect(block).toBe(gen.renderPlaceOrderParitySql(fx));
  });
});
