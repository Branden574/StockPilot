import { describe, expect, it } from 'vitest';

import {
  callArgs,
  countedLikePostgrest,
  inFilters,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from './supabase-mock';

describe('makeSupabaseStub function results', () => {
  it('hands a function result the chain being resolved', async () => {
    const calls: MockCall[] = [];
    const stub = makeSupabaseStub({
      'items.select': (call) => {
        calls.push(call);
        const [, values] = inFilters(call)[0] ?? ['', []];
        return { data: (values as string[]).map((id) => ({ id })), error: null };
      },
    });
    const { data } = await stub.client
      .from('items')
      .select('id')
      .eq('organization_id', 'org')
      .in('id', ['a', 'b'])
      .range(0, 999);
    expect(data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls[0]?.table).toBe('items');
    expect(calls[0]?.op).toBe('select');
    expect(calls[0]?.methods).toEqual(['select', 'eq', 'in', 'range']);
    expect(callArgs(calls[0] as MockCall, 'range')).toEqual([0, 999]);
  });

  it('reports the write op and still serves zero-argument function results', async () => {
    const seen: string[] = [];
    const stub = makeSupabaseStub({
      'items.update': (call) => {
        seen.push(call.op);
        return { data: null, error: null };
      },
      'items.select': () => ({ data: [{ id: 'x' }], error: null }),
    });
    await stub.client.from('items').update({ a: 1 }).in('id', ['a']);
    const { data } = await stub.client.from('items').select('id').maybeSingle();
    expect(seen).toEqual(['update']);
    expect(data).toEqual({ id: 'x' });
  });
});

describe('servedLikePostgrest', () => {
  const rows = [
    { id: 'c', org: 'o1', n: 3, gone: null, flag: false },
    { id: 'a', org: 'o1', n: 1, gone: null, flag: true },
    { id: 'b', org: 'o2', n: 2, gone: null, flag: false },
    { id: 'd', org: 'o1', n: 0, gone: '2026-01-01', flag: false },
  ];

  it('applies the query\'s own filters, order and window', async () => {
    const stub = makeSupabaseStub({ 'items.select': servedLikePostgrest(rows) });
    const { data } = await stub.client
      .from('items')
      .select('id')
      .eq('org', 'o1')
      .is('gone', null)
      .gt('n', 0)
      .order('id', { ascending: true })
      .range(0, 999);
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(['a', 'c']);
    const page2 = await stub.client.from('items').select('id').order('id').range(1, 2);
    expect((page2.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['b', 'c']);
    const inList = await stub.client.from('items').select('id').in('id', ['d', 'b']).eq('flag', false);
    expect((inList.data as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('several .order() calls sort like PostgREST order=a,b: the FIRST is the primary key', async () => {
    const due = [
      { id: 'a', next_run_at: '2026-06-18T09:00:00Z' },
      { id: 'b', next_run_at: '2026-06-18T06:00:00Z' },
      { id: 'c', next_run_at: '2026-06-18T06:00:00Z' },
    ];
    const stub = makeSupabaseStub({ 'items.select': servedLikePostgrest(due) });
    const first = await stub.client
      .from('items')
      .select('id')
      .order('next_run_at', { ascending: true })
      .order('id', { ascending: true })
      .range(0, 0);
    // The earliest next_run_at, not the lowest id (re-sorting per call made
    // the last .order() primary and answered 'a').
    expect((first.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['b']);
    const all = await stub.client
      .from('items')
      .select('id')
      .order('next_run_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, 999);
    expect((all.data as Array<{ id: string }>).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('refuses a filter it cannot evaluate rather than ignoring it', async () => {
    const stub = makeSupabaseStub({ 'items.select': servedLikePostgrest(rows) });
    await expect(
      Promise.resolve().then(() => stub.client.from('items').select('id').or('a.eq.1,b.eq.2')),
    ).rejects.toThrow(/cannot evaluate \.or\(\)/);
  });

  it('evaluates .not(col, "is", null): keeps only the rows whose col is set (an archived-only list)', async () => {
    const stub = makeSupabaseStub({ 'items.select': servedLikePostgrest(rows) });
    const { data } = await stub.client
      .from('items')
      .select('id')
      .eq('org', 'o1')
      .not('gone', 'is', null)
      .order('id')
      .range(0, 999);
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(['d']);
  });

  it('still refuses any other .not() rather than ignoring it', async () => {
    const stub = makeSupabaseStub({ 'items.select': servedLikePostgrest(rows) });
    await expect(
      Promise.resolve().then(() => stub.client.from('items').select('id').not('n', 'eq', 1)),
    ).rejects.toThrow(/cannot evaluate \.not\(n, eq, 1\)/);
    await expect(
      Promise.resolve().then(() => stub.client.from('items').select('id').not('gone', 'is', true)),
    ).rejects.toThrow(/cannot evaluate \.not\(gone, is, true\)/);
  });

  it('evaluates .not(col, "is", null) through .maybeSingle(), as a point read asks', async () => {
    const stub = makeSupabaseStub({ 'items.select': servedLikePostgrest(rows) });
    const one = await stub.client
      .from('items')
      .select('id')
      .eq('org', 'o1')
      .not('gone', 'is', null)
      .maybeSingle();
    expect(one.data).toEqual(expect.objectContaining({ id: 'd' }));
    const none = await stub.client
      .from('items')
      .select('id')
      .eq('org', 'o2')
      .not('gone', 'is', null)
      .maybeSingle();
    expect(none.data).toBeNull();
  });
});

describe('countedLikePostgrest', () => {
  // 1500 rows: past the 1000 rows one response may carry.
  const rows = Array.from({ length: 1500 }, (_, i) => ({
    id: `r${String(i).padStart(4, '0')}`,
    org: i % 3 === 0 ? 'o2' : 'o1',
    gone: i % 5 === 0 ? '2026-01-01' : null,
  }));

  it("answers a head count with the number of rows the query's filters keep, past 1000", async () => {
    const stub = makeSupabaseStub({ 'items.select': countedLikePostgrest(rows) });
    const all = await stub.client.from('items').select('id', { count: 'exact', head: true });
    expect(all).toEqual({ data: null, error: null, count: 1500 });
    const o1 = await stub.client
      .from('items')
      .select('id', { count: 'exact', head: true })
      .eq('org', 'o1');
    expect(o1.count).toBe(rows.filter((r) => r.org === 'o1').length);
    const live = await stub.client
      .from('items')
      .select('id', { count: 'exact', head: true })
      .eq('org', 'o1')
      .is('gone', null)
      .in('id', ['r0001', 'r0002', 'r0005', 'r0010']);
    // r0001 and r0002 are o1 and live; r0005 and r0010 are gone.
    expect(live.count).toBe(2);
  });

  it('serves a select without a head count like servedLikePostgrest', async () => {
    const stub = makeSupabaseStub({ 'items.select': countedLikePostgrest(rows) });
    const { data } = await stub.client.from('items').select('id').order('id').range(0, 999);
    expect(data).toHaveLength(1000);
  });

  it('throws on a method it cannot count', () => {
    const stub = makeSupabaseStub({ 'items.select': countedLikePostgrest(rows) });
    expect(() =>
      stub.client
        .from('items')
        .select('id', { count: 'exact', head: true })
        .gt('id', 'r1')
        .then(() => {}),
    ).toThrow(/cannot evaluate \.gt\(\)/);
  });
});
