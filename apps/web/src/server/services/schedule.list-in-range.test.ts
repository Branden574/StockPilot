import { describe, expect, it, vi } from 'vitest';

/**
 * ScheduleService.listInRange: the events whose [starts_at, ends_at)
 * intersects [from, to), an open-ended event (ends_at null) counting as a
 * point at its start, as the method has always said.
 *
 * THE DEFECT (small fixes slice 8 review). The filter was
 * `or(ends_at.is.null, ends_at.gte.<from>)` with `starts_at < to`, so EVERY
 * open-ended event that started before `to` matched, however long ago:
 * production 2026-10-11 has 31 of 36 events open-ended, 19 of them started
 * more than 45 days ago, all read and thrown away on every month view. The
 * read is ordered oldest first and capped at 500, so once an organization has
 * 500 open-ended events the current month reads only old rows and shows none.
 *
 * The `.or()` is evaluated here the way PostgREST does for the shapes the
 * method uses (and(...), is.null, gte), so the test pins what is read, not
 * the string.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./purchase-orders', () => ({ PurchaseOrdersService: class {} }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest, type MockCall } from '@/test/supabase-mock';

import { ScheduleService } from './schedule';

type Row = Record<string, unknown>;

/** Split PostgREST's comma list at the top level (not inside parentheses). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function matches(row: Row, cond: string): boolean {
  if (cond.startsWith('and(') && cond.endsWith(')')) {
    return splitTop(cond.slice(4, -1)).every((c) => matches(row, c));
  }
  if (cond.startsWith('or(') && cond.endsWith(')')) {
    return splitTop(cond.slice(3, -1)).some((c) => matches(row, c));
  }
  const [col, op, ...rest] = cond.split('.');
  const value = rest.join('.');
  const cell = row[col as string] as string | null | undefined;
  if (op === 'is' && value === 'null') return cell === null || cell === undefined;
  if (cell === null || cell === undefined) return false;
  if (op === 'gte') return Date.parse(cell) >= Date.parse(value);
  if (op === 'gt') return Date.parse(cell) > Date.parse(value);
  if (op === 'lt') return Date.parse(cell) < Date.parse(value);
  if (op === 'lte') return Date.parse(cell) <= Date.parse(value);
  throw new Error(`unsupported condition ${cond}`);
}

/** servedLikePostgrest, with the chain's `.or()` applied first. */
function servedWithOr(rows: Row[]) {
  return (call: MockCall) => {
    let kept = rows;
    const methods: string[] = [];
    const args: unknown[][] = [];
    call.methods.forEach((m, i) => {
      if (m === 'or') kept = kept.filter((r) => splitTop(String(call.args[i]![0])).some((c) => matches(r, c)));
      else {
        methods.push(m);
        args.push(call.args[i]!);
      }
    });
    return servedLikePostgrest(kept)({ ...call, methods, args });
  };
}

const event = (id: string, starts_at: string, ends_at: string | null): Row => ({
  id,
  organization_id: 'org-test',
  title: id,
  starts_at,
  ends_at,
  status: 'scheduled',
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-11-01T00:00:00.000Z');

async function idsInRange(rows: Row[]): Promise<string[]> {
  const stub = makeSupabaseStub({
    'schedule_events.select': servedWithOr(rows),
    'bundle_distributions.select': { data: [], error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'schedule' as ModuleId]),
  });
  const out = await new ScheduleService(ctx as never).listInRange(FROM, TO);
  return out.map((e) => e.id);
}

describe('ScheduleService.listInRange reads only the events that touch the range', () => {
  it('leaves out an open-ended event that started before the range', async () => {
    expect(
      await idsInRange([
        event('old-open', '2026-08-02T17:00:00Z', null),
        event('in-open', '2026-10-15T17:00:00Z', null),
      ]),
    ).toEqual(['in-open']);
  });

  it('keeps an event that started before the range and ends inside it, and one that spans it', async () => {
    expect(
      await idsInRange([
        event('ends-inside', '2026-09-30T20:00:00Z', '2026-10-01T02:00:00Z'),
        event('spans', '2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z'),
        event('ended-before', '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'),
        event('starts-after', '2026-11-02T00:00:00Z', null),
      ]),
    ).toEqual(['spans', 'ends-inside']);
  });

  it('an open-ended event at the very start of the range is in it', async () => {
    expect(await idsInRange([event('at-from', FROM.toISOString(), null)])).toEqual(['at-from']);
  });

  it('500 old open-ended events no longer crowd out the month', async () => {
    const old = Array.from({ length: 500 }, (_, i) =>
      event(`old-${i}`, new Date(Date.parse('2025-01-01T00:00:00Z') + i * 3_600_000).toISOString(), null),
    );
    expect(await idsInRange([...old, event('this-month', '2026-10-15T17:00:00Z', null)])).toEqual(['this-month']);
  });
});
