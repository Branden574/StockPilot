import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async () => ({ written: 0, lost: 0 })),
}));

import { CategoriesService } from './categories';
import { ProcedureCategoriesService } from './procedure-categories';
import { TagsService } from './tags';

/**
 * The services that write a stored colour refuse anything but the `#rrggbb`
 * form the app writes, themselves, before any query (docket T14). The actions
 * check first; this keeps every other server path that reaches a service (a
 * future API route, a job) from saving a colour that a page would draw.
 */

const INJECTED = [
  '#000;position:fixed;inset:0;z-index:2147483647',
  'red;position:fixed',
  '#6366f1;',
  ' #6366f1',
  'url(https://x.example/a.png)',
  '#fff',
];

const ID = '0f8c3f6e-1111-4222-8333-944455556666';
const SAVED = { id: ID, name: 'Saved', color: '#6366f1', sort_order: 0 };

function stub() {
  return makeSupabaseStub({
    'categories.insert': { data: SAVED, error: null },
    'categories.update': { data: SAVED, error: null },
    'tags.insert': { data: SAVED, error: null },
    'tags.update': { data: SAVED, error: null },
    'procedure_categories.insert': { data: SAVED, error: null },
    'procedure_categories.update': { data: SAVED, error: null },
  });
}

type Write = (client: unknown, color: string | null) => Promise<unknown>;

const WRITES: Array<{ name: string; table: string; write: Write }> = [
  {
    name: 'CategoriesService.create',
    table: 'categories',
    write: (client, color) =>
      new CategoriesService(makeServiceContext(client)).create({
        name: 'Swag',
        color: color as string,
      }),
  },
  {
    name: 'CategoriesService.update',
    table: 'categories',
    write: (client, color) =>
      new CategoriesService(makeServiceContext(client)).update(ID, { color: color as string }),
  },
  {
    name: 'TagsService.create',
    table: 'tags',
    write: (client, color) =>
      new TagsService(makeServiceContext(client)).create({ name: 'Fragile', color }),
  },
  {
    name: 'TagsService.update',
    table: 'tags',
    write: (client, color) => new TagsService(makeServiceContext(client)).update(ID, { color }),
  },
  {
    name: 'ProcedureCategoriesService.create',
    table: 'procedure_categories',
    write: (client, color) =>
      new ProcedureCategoriesService(makeServiceContext(client)).create({ name: 'Safety', color }),
  },
  {
    name: 'ProcedureCategoriesService.update',
    table: 'procedure_categories',
    write: (client, color) =>
      new ProcedureCategoriesService(makeServiceContext(client)).update(ID, { color }),
  },
];

beforeEach(() => vi.clearAllMocks());

describe('services refuse a stored colour that is not #rrggbb (T14)', () => {
  for (const { name, table, write } of WRITES) {
    it(`${name} refuses it before any query`, async () => {
      for (const color of INJECTED) {
        const s = stub();
        await expect(write(s.client, color), color).rejects.toMatchObject({
          code: 'validation_error',
          message: 'Use a hex color like #6366f1',
        });
        expect(s.fromCalls, color).toEqual([]);
      }
    });

    it(`${name} saves a #rrggbb colour`, async () => {
      const s = stub();
      await write(s.client, '#6366f1');
      expect(s.fromCalls).toContain(table);
    });
  }

  it('a cleared colour (null) is still allowed where the column may be cleared', async () => {
    for (const { name, table, write } of WRITES.filter((w) => w.table !== 'categories')) {
      const s = stub();
      await write(s.client, null);
      expect(s.fromCalls, name).toContain(table);
    }
  });
});
