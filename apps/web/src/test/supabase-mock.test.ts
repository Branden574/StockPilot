import { describe, expect, it } from 'vitest';

import { callArgs, inFilters, makeSupabaseStub, type MockCall } from './supabase-mock';

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
