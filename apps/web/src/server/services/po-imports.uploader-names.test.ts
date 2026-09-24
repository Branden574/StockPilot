import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PoImportsService.uploaderProfiles: who uploaded each import, for the list's
 * and the detail page's "Uploaded by".
 *
 * - Read with the caller's client from user_profiles (never a service role),
 *   batched, because one `.in()` past ~215 uuids fails.
 * - A failed lookup is reported and answers null, so the label says "—"
 *   instead of every uploader turning into a "Former member" in silence.
 */

const { reportError, createAdminClient } = vi.hoisted(() => ({
  reportError: vi.fn(async () => undefined),
  createAdminClient: vi.fn(),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}), auditMany: vi.fn() }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));

import { DEFAULT_MODULE_IDS, poImportUploaderLabel, type ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { PoImportsService } from './po-imports';

const uuid = (i: number) => `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`;
const MODULES = new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'po_imports' as ModuleId]);

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

function service(stub: ReturnType<typeof makeSupabaseStub>) {
  return new PoImportsService(
    makeServiceContext(stub.client, { enabledModules: MODULES }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PoImportsService.uploaderProfiles', () => {
  it('reads name and email from user_profiles, keyed by id, and the labels follow', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': {
        data: [
          { id: uuid(1), full_name: 'Marissa Lopez', email: 'marissa@cvwest.org' },
          { id: uuid(2), full_name: null, email: 'crystal@cvwest.org' },
        ],
        error: null,
      },
    });
    const profiles = await service(stub).uploaderProfiles([uuid(1), uuid(2), uuid(3), uuid(1)]);
    expect(stub.chainArgsAll.get('user_profiles.select')?.[0]?.[0]).toEqual([
      'id, full_name, email',
    ]);
    expect(poImportUploaderLabel(profiles, uuid(1))).toBe('Marissa Lopez');
    expect(poImportUploaderLabel(profiles, uuid(2))).toBe('crystal@cvwest.org');
    // Not returned under RLS: no longer shares the org.
    expect(poImportUploaderLabel(profiles, uuid(3))).toBe('Former member');
    expect(reportError).not.toHaveBeenCalled();
    // The caller's client, never a service-role shortcut around RLS.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('batches 250 uploaders into lookups of at most 100 ids', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'user_profiles.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return {
          data: list.map((id) => ({ id, full_name: `Name ${id.slice(-3)}`, email: null })),
          error: null,
        };
      },
    });
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
    const profiles = await service(stub).uploaderProfiles(ids);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(profiles?.size).toBe(250);
    expect(poImportUploaderLabel(profiles, uuid(249))).toBe('Name 249');
  });

  it('answers null and reports when the lookup fails, and the label degrades to "—"', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: null, error: { message: 'fetch failed' } },
    });
    const profiles = await service(stub).uploaderProfiles([uuid(1), uuid(2)]);
    expect(profiles).toBeNull();
    expect(poImportUploaderLabel(profiles, uuid(1))).toBe('—');
    expect(tags()).toEqual(['po_imports.uploader_names']);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'po_imports.uploader_names',
      level: 'warning',
      extra: expect.objectContaining({ users: 2 }),
    });
  });

  it('makes no request when there is nobody to look up', async () => {
    const stub = makeSupabaseStub({});
    expect(await service(stub).uploaderProfiles([])).toEqual(new Map());
    expect(stub.fromCalls).not.toContain('user_profiles');
  });
});
