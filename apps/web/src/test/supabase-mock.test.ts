import { describe, expect, it } from 'vitest';

import {
  callArgs,
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
});
