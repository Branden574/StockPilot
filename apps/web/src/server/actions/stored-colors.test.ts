import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS } from '@stockpilot/core';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * WHERE A COLOUR IS SAVED (docket T14): the category, tag and procedure-
 * category actions accept only the `#rrggbb` form the app writes, and refuse
 * anything else before the database is touched. Each action runs through its
 * real service against a stub client, so a refusal is proved by the stub
 * seeing no query at all.
 */

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async () => ({ written: 0, lost: 0 })),
}));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
      supabase: stubHolder.stub!.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(DEFAULT_MODULE_IDS),
    })),
  };
});

import { createCategoryAction, updateCategoryAction } from './categories';
import { createProcedureCategoryAction, updateProcedureCategoryAction } from './procedures';
import { createTagAction, updateTagAction } from './tags';

const INJECTED = [
  '#000;position:fixed;inset:0;z-index:2147483647;background:#fff;font-size:40px',
  'red;position:fixed',
  '#6366f1;',
  ' #6366f1',
  'url(https://x.example/a.png)',
  '#fff',
];

const ID = '0f8c3f6e-1111-4222-8333-944455556666';

const row = (table: string) => ({
  id: ID,
  name: 'Saved',
  color: '#6366f1',
  ...(table === 'procedure_categories' ? { sort_order: 0 } : {}),
});

function freshStub() {
  stubHolder.stub = makeSupabaseStub({
    'categories.insert': { data: row('categories'), error: null },
    'categories.update': { data: row('categories'), error: null },
    'tags.insert': { data: row('tags'), error: null },
    'tags.update': { data: row('tags'), error: null },
    'procedure_categories.insert': { data: row('procedure_categories'), error: null },
    'procedure_categories.update': { data: row('procedure_categories'), error: null },
  });
  return stubHolder.stub;
}

const ACTIONS: Array<{
  name: string;
  table: string;
  run: (
    color: string | null,
  ) => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
}> = [
  {
    name: 'createCategoryAction',
    table: 'categories',
    run: (color) => createCategoryAction({ name: 'Swag', color: color as string }),
  },
  {
    name: 'updateCategoryAction',
    table: 'categories',
    run: (color) => updateCategoryAction(ID, { color: color as string }),
  },
  {
    name: 'createTagAction',
    table: 'tags',
    run: (color) => createTagAction({ name: 'Fragile', color }),
  },
  { name: 'updateTagAction', table: 'tags', run: (color) => updateTagAction(ID, { color }) },
  {
    name: 'createProcedureCategoryAction',
    table: 'procedure_categories',
    run: (color) => createProcedureCategoryAction({ name: 'Safety', color }),
  },
  {
    name: 'updateProcedureCategoryAction',
    table: 'procedure_categories',
    run: (color) => updateProcedureCategoryAction(ID, { color }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the colour actions refuse anything but #rrggbb before the database (T14)', () => {
  for (const action of ACTIONS) {
    it(`${action.name} refuses an injected colour and never queries`, async () => {
      for (const color of INJECTED) {
        const stub = freshStub();
        const res = await action.run(color);
        expect(res.ok, color).toBe(false);
        expect(res.error?.code, color).toBe('validation_error');
        expect(res.error?.message, color).toBe('Use a hex color like #6366f1');
        expect(stub.fromCalls, color).toEqual([]);
      }
    });

    it(`${action.name} saves a #rrggbb colour`, async () => {
      const stub = freshStub();
      const res = await action.run('#6366f1');
      expect(res.ok).toBe(true);
      expect(stub.fromCalls).toContain(action.table);
    });
  }
});
