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
  ORDER_BODY_UNREADABLE_COPY,
  orderCreateRefusalCopy,
  orderShapeRefusalFromSql,
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
  SQL_FIELDS: string[];
}

/** Every character String.prototype.trim removes (ECMAScript WhiteSpace and
 *  LineTerminator: tab, vertical tab, form feed, space, no-break space, the
 *  byte-order mark, the Zs space separators, line feed, carriage return, line
 *  and paragraph separators). */
const JS_TRIM_SET = [
  '\t',
  '\n',
  '\u000b',
  '\f',
  '\r',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  ' ',
  '　',
  '﻿',
];
/** Characters that look like whitespace but String.prototype.trim keeps. */
const NOT_TRIMMED = ['\u0085', '​'];

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

  it("the words are the sentence for the case, not just the function's own answer", () => {
    const words = (id: string) => {
      const n = fx.cases.findIndex((c) => c.id === id) + 1;
      const r = parseOrderCreateRequest(gen.caseBody(fx, fx.cases[n - 1]!, n));
      return r.ok ? null : r.refusal.message;
    };
    expect(words('R21')).toBe("A pickup order doesn't take a delivery site.");
    expect(words('R25')).toBe(ORDER_BODY_UNREADABLE_COPY);
    expect(words('R41')).toBe('An order request can have at most 100 lines.');
  });

  it('R41 is 101 lines of ONE item, so the line cap is pinned before the sum', () => {
    const n = fx.cases.findIndex((c) => c.id === 'R41') + 1;
    const c = fx.cases[n - 1]!;
    const lines = gen.caseBody(fx, c, n).lines as Array<{ itemId: string; quantity: number }>;
    expect(lines).toHaveLength(101);
    expect(new Set(lines.map((l) => l.itemId)).size).toBe(1);
    const sqlLines = gen.caseSqlRequest(fx, c, n).lines as Array<{ item_id: string }>;
    expect(new Set(sqlLines.map((l) => l.item_id)).size).toBe(1);
  });

  it("both engines trim JavaScript's whole whitespace set, and nothing else", () => {
    // The list is JavaScript's: each is trimmed, and the two others are not.
    for (const ch of JS_TRIM_SET) expect(`${ch}x${ch}`.trim(), JSON.stringify(ch)).toBe('x');
    for (const ch of NOT_TRIMMED) expect(`${ch}x`.trim(), JSON.stringify(ch)).toBe(`${ch}x`);
    type OnBehalf = { onBehalfOf?: { name?: unknown; email?: unknown } | null };
    const onBehalf = (pick: (c: ParityCase) => boolean, key: 'name' | 'email') =>
      fx.cases.flatMap((c, i) => {
        if (!pick(c)) return [];
        const v = (gen.caseBody(fx, c, i + 1) as OnBehalf).onBehalfOf?.[key];
        return typeof v === 'string' ? [v] : [];
      });
    // The fixture pads a name and an email in an ACCEPTED body with every
    // trimmed character, so a database trim with a smaller set fails it...
    const acceptedNames = onBehalf((c) => c.core === 'accept' && c.sql === 'accept', 'name');
    const acceptedEmails = onBehalf((c) => c.core === 'accept' && c.sql === 'accept', 'email');
    for (const ch of JS_TRIM_SET) {
      expect(
        acceptedNames.some((v) => v.includes(ch)),
        `no accepted name ${JSON.stringify(ch)}`,
      ).toBe(true);
      expect(
        acceptedEmails.some((v) => v.includes(ch)),
        `no accepted email ${JSON.stringify(ch)}`,
      ).toBe(true);
    }
    // ...and refuses an email that keeps a character JavaScript does not
    // trim, so a database trim with a larger set fails it too.
    const refusedEmails = onBehalf(
      (c) => c.core !== 'accept' && c.sql !== 'accept' && c.sql !== 'unreachable',
      'email',
    );
    for (const ch of NOT_TRIMMED) {
      expect(
        refusedEmails.some((v) => v.includes(ch)),
        `no refused email keeps ${JSON.stringify(ch)}`,
      ).toBe(true);
    }
  });

  it("a database shape refusal maps to core's reason wherever the fixture pairs them one to one", () => {
    // fields that stand for several core reasons answer invalid/body
    const ambiguous = new Set(['lines', 'quantity', 'surface']);
    let checked = 0;
    for (const c of fx.cases) {
      if (c.core === 'accept' || c.sql === 'accept' || c.sql === 'unreachable') continue;
      if (c.sql.sqlstate !== '22023') continue;
      const mapped = orderShapeRefusalFromSql(c.sql.hint, c.sql.field ?? null);
      if (c.sql.field && ambiguous.has(c.sql.field)) {
        expect(mapped, c.id).toEqual({ reason: 'invalid', field: 'body' });
      } else {
        expect(mapped, c.id).toEqual(c.core.field ? c.core : { reason: c.core.reason });
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
    // Every field the database may name has an answer, and a field the
    // fixture never pairs (the service sets it) is the body's fault.
    for (const f of gen.SQL_FIELDS) {
      expect(orderShapeRefusalFromSql('order_invalid', f).reason, f).toBeDefined();
    }
    expect(orderShapeRefusalFromSql('order_invalid', 'surface')).toEqual({
      reason: 'invalid',
      field: 'body',
    });
    expect(orderShapeRefusalFromSql('order_invalid', null)).toEqual({
      reason: 'invalid',
      field: 'body',
    });
    expect(orderShapeRefusalFromSql('something_else', 'notes')).toEqual({
      reason: 'invalid',
      field: 'body',
    });
  });

  it('the rendered block is printable ASCII: no invisible character can be lost in the .sql file', () => {
    const block = gen.renderPlaceOrderParitySql(fx);
    // eslint-disable-next-line no-control-regex
    expect(block).toMatch(/^[\x20-\x7e\n]*$/);
    // ...and every escaped value still reads back to the body's value.
    const n = fx.cases.findIndex((c) => c.id === 'A13') + 1;
    const c = fx.cases[n - 1]!;
    const row = block.split('\n').find((l) => l.includes(`'${c.id}'`))!;
    const json = row.slice(row.indexOf("'{") + 1, row.indexOf("}'::jsonb") + 1).replace(/''/g, "'");
    expect(JSON.parse(json)).toEqual(gen.caseSqlRequest(fx, c, n));
  });

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
