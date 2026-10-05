import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseReturnBody, returnSchemaCases, returnSchemas } from './return-schemas';

const TESTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/tests');
const L1 = '00000000-0000-4000-8000-000000000001';
const L2 = '00000000-0000-4000-8000-000000000002';

describe('the case table shared with pgTAP', () => {
  const file = readdirSync(TESTS).find((f) => f.endsWith('_returns_lifecycle_original_rack.test.sql'));
  const sql = file ? readFileSync(join(TESTS, file), 'utf8') : '';
  const markers = new Set([...sql.matchAll(/^-- case: ([a-z0-9_]+)\s*$/gm)].map((m) => m[1]));

  it('finds the RX-1 suite', () => {
    expect(file).toBeDefined();
  });

  it.each(returnSchemaCases().map((c) => [c.name, c] as const))('%s has a pgTAP marker and core agrees', (name, c) => {
    expect(markers.has(name)).toBe(true);
    expect(parseReturnBody(c.schema, c.input).ok).toBe(c.coreAccepts);
  });

  it('has no marker without a core case', () => {
    const names = new Set(returnSchemaCases().map((c) => c.name));
    expect([...markers].filter((m) => !names.has(m!))).toEqual([]);
  });
});

describe('the create bodies', () => {
  it('accepts whole units with an optional disposition and key, trimming notes', () => {
    const r = parseReturnBody('create', {
      reasonCode: 'damaged',
      notes: '  wrong size  ',
      lines: [{ orderRequestLineId: L1, quantity: 2, disposition: 'scrap' }],
      itemIsHere: true,
      idempotencyKey: L2,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.notes).toBe('wrong size');
      expect(r.value.lines[0]!.disposition).toBe('scrap');
    }
    const blank = parseReturnBody('create', { notes: '   ', lines: [{ orderRequestLineId: L1, quantity: 1 }] });
    expect(blank.ok && blank.value.notes).toBeUndefined();
  });

  it('refuses notes over 2,000 characters and an unknown reason', () => {
    expect(parseReturnBody('create', { notes: 'x'.repeat(2001), lines: [{ orderRequestLineId: L1, quantity: 1 }] }).ok).toBe(false);
    expect(parseReturnBody('create', { reasonCode: 'lost', lines: [{ orderRequestLineId: L1, quantity: 1 }] }).ok).toBe(false);
  });

  it('the requester body strips a disposition and caps the total at 10,000 units', () => {
    const r = parseReturnBody('requester', { lines: [{ orderRequestLineId: L1, quantity: 1, disposition: 'scrap' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0]).not.toHaveProperty('disposition');
    const many = parseReturnBody('requester', {
      lines: [
        { orderRequestLineId: L1, quantity: 6000 },
        { orderRequestLineId: L2, quantity: 6000 },
      ],
    });
    expect(many.ok).toBe(false);
  });
});

describe('the decision bodies', () => {
  it('a source names its rack, and only a source does', () => {
    const ok = parseReturnBody('approve', { lines: [{ returnLineId: L1, disposition: 'restock', restock: { target: 'source', locationId: L2 } }] });
    expect(ok.ok).toBe(true);
    expect(parseReturnBody('approve', { lines: [{ returnLineId: L1, disposition: 'restock', restock: { target: 'source' } }] }).ok).toBe(false);
    expect(
      parseReturnBody('approve', { lines: [{ returnLineId: L1, disposition: 'restock', restock: { target: 'original', locationId: L2 } }] }).ok,
    ).toBe(false);
  });

  it('a repeated returned line is refused', () => {
    expect(
      parseReturnBody('dispositions', {
        lines: [
          { returnLineId: L1, disposition: 'scrap' },
          { returnLineId: L1, disposition: 'restock' },
        ],
      }).ok,
    ).toBe(false);
  });

  it('deny takes a trimmed reason; cancel takes an optional one and a revision', () => {
    const d = parseReturnBody('deny', { reason: '  Not ours ' });
    expect(d.ok && d.value.reason).toBe('Not ours');
    expect(parseReturnBody('cancel', {}).ok).toBe(true);
    expect(parseReturnBody('cancel', { reason: 'x'.repeat(1001) }).ok).toBe(false);
    expect(parseReturnBody('cancel', { expectedRevision: -1 }).ok).toBe(false);
  });
});

describe('the steps body', () => {
  const approve = { lines: [{ returnLineId: L1, disposition: 'restock', restock: { target: 'staging' } }] };

  it('runs approve, receive, process in that order, once each', () => {
    expect(parseReturnBody('steps', { steps: ['approve'], expectedRevision: 0, approve }).ok).toBe(true);
    expect(parseReturnBody('steps', { steps: ['receive', 'process'], expectedRevision: null }).ok).toBe(true);
    expect(parseReturnBody('steps', { steps: ['process', 'receive'] }).ok).toBe(false);
    expect(parseReturnBody('steps', { steps: ['receive', 'receive'] }).ok).toBe(false);
    expect(parseReturnBody('steps', { steps: [] }).ok).toBe(false);
  });

  it('an approve step needs its decision and the expected revision', () => {
    expect(parseReturnBody('steps', { steps: ['approve'], expectedRevision: 0 }).ok).toBe(false);
    expect(parseReturnBody('steps', { steps: ['approve'], approve }).ok).toBe(false);
  });

  it('"Approve and receive" is one step (receiveNow), never approve plus receive', () => {
    expect(parseReturnBody('steps', { steps: ['approve'], expectedRevision: 0, approve, receiveNow: true }).ok).toBe(true);
    expect(parseReturnBody('steps', { steps: ['approve', 'receive'], expectedRevision: 0, approve, receiveNow: true }).ok).toBe(false);
  });

  it('builds the schemas once', () => {
    expect(returnSchemas()).toBe(returnSchemas());
  });
});
