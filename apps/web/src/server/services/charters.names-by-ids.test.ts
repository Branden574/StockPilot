import { describe, expect, it } from 'vitest';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import { ChartersService } from './charters';
import { ServiceError } from './context';

/**
 * ChartersService.namesByIds (S44): the name and status of the charters a
 * member or a record already holds, read by id at ANY status, for a label. The
 * pickers list active charters only, so a held charter that has been archived
 * (or set inactive) had no name to show. A label read: it never decides which
 * charters anyone holds.
 */

const ORG = 'org-test';
const ACTIVE = '00000000-0000-4000-8000-0000000000a1';
const INACTIVE = '00000000-0000-4000-8000-0000000000b1';
const ARCHIVED = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000d1';

function row(id: string, name: string, status: string, organization_id = ORG) {
  return {
    id,
    organization_id,
    name,
    status,
    code: null,
    address: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const ROWS = [
  row(ACTIVE, 'North Campus', 'active'),
  row(INACTIVE, 'Closed Campus', 'inactive'),
  row(ARCHIVED, 'Old Campus', 'archived'),
  row(OTHER_ORG, 'Elsewhere Campus', 'archived', 'org-other'),
];

const svcFor = (client: unknown) => new ChartersService(makeServiceContext(client) as never);

describe('ChartersService.namesByIds', () => {
  it('returns id, name and status at any status, and nothing from another organization', async () => {
    const stub = makeSupabaseStub({ 'charters.select': servedLikePostgrest(ROWS) });

    const out = await svcFor(stub.client).namesByIds([ACTIVE, INACTIVE, ARCHIVED, OTHER_ORG]);

    expect([...out].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: ACTIVE, name: 'North Campus', status: 'active' },
      { id: INACTIVE, name: 'Closed Campus', status: 'inactive' },
      { id: ARCHIVED, name: 'Old Campus', status: 'archived' },
    ]);
    const select = String(stub.chainArgsAll.get('charters.select')?.[0]?.[0]?.[0] ?? '');
    expect(select.replace(/\s+/g, '')).toBe('id,name,status');
  });

  it('drops ids that are not uuids, lowercases and dedupes before the read', async () => {
    const seen: string[][] = [];
    const served = servedLikePostgrest(ROWS);
    const stub = makeSupabaseStub({
      'charters.select': (call: MockCall) => {
        seen.push((inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[]);
        return served(call);
      },
    });

    const out = await svcFor(stub.client).namesByIds([
      'not-a-uuid',
      '',
      ARCHIVED.toUpperCase(),
      ARCHIVED,
    ]);

    expect(seen).toEqual([[ARCHIVED]]);
    expect(out).toEqual([{ id: ARCHIVED, name: 'Old Campus', status: 'archived' }]);
  });

  it('reads 250 ids in batches of at most 100 and returns every row', async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      row(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Campus ${i}`, 'archived'),
    );
    const sizes: number[] = [];
    const served = servedLikePostgrest(many);
    const stub = makeSupabaseStub({
      'charters.select': (call: MockCall) => {
        sizes.push(((inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[]).length);
        return served(call);
      },
    });

    const out = await svcFor(stub.client).namesByIds(many.map((c) => c.id));

    expect(sizes.every((n) => n <= 100)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
    expect(new Set(out.map((c) => c.id))).toEqual(new Set(many.map((c) => c.id)));
  });

  it('sends no request for no ids', async () => {
    const stub = makeSupabaseStub({ 'charters.select': servedLikePostgrest(ROWS) });

    expect(await svcFor(stub.client).namesByIds([])).toEqual([]);
    expect(await svcFor(stub.client).namesByIds(['not-a-uuid'])).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('throws on a failed read, with the PostgREST text kept for the log', async () => {
    const stub = makeSupabaseStub({
      'charters.select': { data: null, error: { message: 'upstream connect error' } },
    });

    const err = await svcFor(stub.client)
      .namesByIds([ARCHIVED])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
    expect((err as ServiceError).internalDetail).toContain('upstream connect error');
  });
});
