import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable session state so per-test role overrides work (the
// email-routing-settings.test.ts pattern).
const sessionState = {
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  userId: 'user-1',
};

// One mutable response per table verb; each test sets what the "db" returns.
const dbState: {
  listRows: unknown[] | null;
  listError: { code?: string; message: string } | null;
  insertRow: unknown | null;
  insertError: { code?: string; message: string } | null;
  deleteRow: unknown | null;
  deleteError: { code?: string; message: string } | null;
} = {
  listRows: [],
  listError: null,
  insertRow: null,
  insertError: null,
  deleteRow: null,
  deleteError: null,
};

const insertSpy = vi.fn();
const deleteEqSpy = vi.fn();

function makeClient() {
  return {
    from: vi.fn((table: string) => {
      if (table !== 'export_presets') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({ data: dbState.listRows, error: dbState.listError }),
          }),
        }),
        insert: (payload: unknown) => {
          insertSpy(payload);
          return {
            select: () => ({
              maybeSingle: async () => ({ data: dbState.insertRow, error: dbState.insertError }),
            }),
          };
        },
        delete: () => ({
          eq: (...a: unknown[]) => {
            deleteEqSpy(...a);
            return {
              eq: (...b: unknown[]) => {
                deleteEqSpy(...b);
                return {
                  select: () => ({
                    maybeSingle: async () => ({
                      data: dbState.deleteRow,
                      error: dbState.deleteError,
                    }),
                  }),
                };
              },
            };
          },
        }),
      };
    }),
  };
}

const auditSpy = vi.fn(async () => undefined);
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => auditSpy(...(a as [])) }));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  const { ROLE_PERMISSIONS } = await vi.importActual<typeof import('@stockpilot/core')>(
    '@stockpilot/core',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: sessionState.userId,
      role: sessionState.role,
      permissions: new Set(ROLE_PERMISSIONS[sessionState.role]),
      supabase: makeClient(),
      mfaRequired: false,
      mfaSatisfied: true,
    })),
  };
});

import {
  deleteSharedExportPresetAction,
  listSharedExportPresetsAction,
  saveSharedExportPresetAction,
} from './export-presets';

const GOOD_CONFIG = {
  itemTypeKind: 'book' as const,
  fieldKeys: ['name', 'isbn', 'quantity_on_hand'] as never[],
  format: 'pdf' as const,
};

beforeEach(() => {
  sessionState.role = 'manager';
  sessionState.userId = 'user-1';
  dbState.listRows = [];
  dbState.listError = null;
  dbState.insertRow = null;
  dbState.insertError = null;
  dbState.deleteRow = null;
  dbState.deleteError = null;
  insertSpy.mockClear();
  deleteEqSpy.mockClear();
  auditSpy.mockClear();
});

describe('listSharedExportPresetsAction', () => {
  it('returns presets with parsed configs and per-preset dropped-field notes', async () => {
    dbState.listRows = [
      {
        id: 'p1',
        name: 'Warehouse walk',
        config: { itemTypeKind: 'book', fieldKeys: ['name', 'retired_field', 'isbn'] },
        created_by: 'user-1',
        created_at: '2026-08-16T00:00:00Z',
      },
    ];
    const res = await listSharedExportPresetsAction();
    if (!res.ok) throw new Error(res.error.message);
    expect(res.data.available).toBe(true);
    expect(res.data.presets).toEqual([
      {
        id: 'p1',
        name: 'Warehouse walk',
        createdBy: 'user-1',
        createdAt: '2026-08-16T00:00:00Z',
        config: { itemTypeKind: 'book', fieldKeys: ['name', 'isbn'] },
        droppedFieldKeys: ['retired_field'],
        canDelete: true, // creator
      },
    ]);
  });

  it('computes canDelete as creator-or-admin, mirroring the RLS delete policy', async () => {
    dbState.listRows = [
      { id: 'p1', name: 'A', config: GOOD_CONFIG, created_by: 'someone-else', created_at: 't' },
    ];
    sessionState.role = 'manager';
    const asManager = await listSharedExportPresetsAction();
    if (!asManager.ok) throw new Error('expected ok');
    expect(asManager.data.presets[0]!.canDelete).toBe(false);

    sessionState.role = 'admin';
    const asAdmin = await listSharedExportPresetsAction();
    if (!asAdmin.ok) throw new Error('expected ok');
    expect(asAdmin.data.presets[0]!.canDelete).toBe(true);
  });

  it('returns an unreadable config as null (deletable, never applicable) instead of erroring', async () => {
    dbState.listRows = [
      { id: 'p1', name: 'Broken', config: 'scalar', created_by: 'user-1', created_at: 't' },
    ];
    const res = await listSharedExportPresetsAction();
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.presets[0]!.config).toBeNull();
    expect(res.data.presets[0]!.canDelete).toBe(true);
  });

  it('maps a missing table (PGRST205 — the code PostgREST REALLY returns) to available:false', async () => {
    // MEASURED, not assumed: PostgREST refuses a missing table at its own
    // schema cache with PGRST205 before Postgres can raise 42P01. The first
    // version of this test fed the mock 42P01 — the code the implementation
    // happened to check — and thereby certified a wrong premise instead of
    // testing it. The real deploy-window code is pinned first; the 42P01
    // variant below stays as the belt-and-braces path.
    dbState.listRows = null;
    dbState.listError = { code: 'PGRST205', message: "Could not find the table 'public.export_presets' in the schema cache" };
    const res = await listSharedExportPresetsAction();
    expect(res).toEqual({ ok: true, data: { available: false, presets: [] } });
  });

  it('still maps raw-Postgres 42P01 to available:false — the belt-and-braces path', async () => {
    // Reachable only when something bypasses the PostgREST schema cache
    // (direct RPC, or a stale cache racing a dropped table). Kept so the
    // fallback never narrows to a single transport's spelling of "missing".
    dbState.listRows = null;
    dbState.listError = { code: '42P01', message: 'relation "export_presets" does not exist' };
    const res = await listSharedExportPresetsAction();
    expect(res).toEqual({ ok: true, data: { available: false, presets: [] } });
  });

  it('refuses a role without items:export', async () => {
    sessionState.role = 'viewer';
    const res = await listSharedExportPresetsAction();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('forbidden');
  });
});

describe('saveSharedExportPresetAction', () => {
  const savedRow = {
    id: 'p9',
    name: 'Friday count',
    config: GOOD_CONFIG,
    created_by: 'user-1',
    created_at: '2026-08-16T00:00:00Z',
  };

  it('saves and AUDITS with the full stored config in the payload', async () => {
    dbState.insertRow = savedRow;
    const res = await saveSharedExportPresetAction({ name: '  Friday count ', config: GOOD_CONFIG });
    if (!res.ok) throw new Error(res.error.message);
    expect(res.data.id).toBe('p9');
    expect(insertSpy).toHaveBeenCalledWith({
      organization_id: 'org-1',
      name: 'Friday count',
      config: GOOD_CONFIG,
      created_by: 'user-1',
    });
    // The PAYLOAD, not just "audit was called" — the hollow assertion this
    // week's review flagged.
    expect(auditSpy).toHaveBeenCalledWith({
      event: 'export_preset.saved',
      entityType: 'export_preset',
      entityId: 'p9',
      after: {
        name: 'Friday count',
        itemTypeKind: 'book',
        fieldKeys: ['name', 'isbn', 'quantity_on_hand'],
        format: 'pdf',
      },
    });
  });

  it('surfaces a duplicate name (23505) as a humane conflict', async () => {
    dbState.insertError = { code: '23505', message: 'duplicate key value' };
    const res = await saveSharedExportPresetAction({ name: 'Friday count', config: GOOD_CONFIG });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'A preset with this name already exists in your organization. Delete it first, or pick another name.',
      },
    });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('REFUSES a config with unknown field ids — save repairs nothing', async () => {
    const res = await saveSharedExportPresetAction({
      name: 'Smuggle',
      config: { ...GOOD_CONFIG, fieldKeys: ['name', 'forged_field'] as never[] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('validation_error');
    expect(res.error.message).toBe('Unknown export fields cannot be saved: forged_field.');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('refuses an empty field list, a blank name and an over-long name', async () => {
    const empty = await saveSharedExportPresetAction({
      name: 'Empty',
      config: { ...GOOD_CONFIG, fieldKeys: [] as never[] },
    });
    expect(empty.ok).toBe(false);
    const blank = await saveSharedExportPresetAction({ name: '   ', config: GOOD_CONFIG });
    expect(blank.ok).toBe(false);
    const long = await saveSharedExportPresetAction({ name: 'x'.repeat(61), config: GOOD_CONFIG });
    expect(long.ok).toBe(false);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('refuses a role without items:export before touching the db', async () => {
    sessionState.role = 'staff';
    const res = await saveSharedExportPresetAction({ name: 'Nope', config: GOOD_CONFIG });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('forbidden');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('maps a missing table to the humane not-available message', async () => {
    dbState.insertError = { code: 'PGRST205', message: "Could not find the table 'public.export_presets' in the schema cache" };
    const res = await saveSharedExportPresetAction({ name: 'Early', config: GOOD_CONFIG });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toBe(
      'Shared presets are not available yet. Try again after the next update.',
    );
  });
});

describe('deleteSharedExportPresetAction', () => {
  const victim = {
    id: 'p3',
    name: 'Old preset',
    config: GOOD_CONFIG,
    created_by: 'user-2',
    created_at: 't',
  };

  it('deletes and AUDITS what was removed', async () => {
    dbState.deleteRow = victim;
    const res = await deleteSharedExportPresetAction({ id: 'p3' });
    expect(res).toEqual({ ok: true, data: { id: 'p3' } });
    expect(auditSpy).toHaveBeenCalledWith({
      event: 'export_preset.deleted',
      entityType: 'export_preset',
      entityId: 'p3',
      before: { name: 'Old preset', createdBy: 'user-2', config: GOOD_CONFIG },
    });
  });

  it('fails CLOSED on a 0-row delete (pattern #22: RLS refusals are silent)', async () => {
    dbState.deleteRow = null; // statement "succeeded", nothing deleted
    const res = await deleteSharedExportPresetAction({ id: 'p3' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('forbidden');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('refuses a role without items:export', async () => {
    sessionState.role = 'viewer';
    const res = await deleteSharedExportPresetAction({ id: 'p3' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('forbidden');
    expect(deleteEqSpy).not.toHaveBeenCalled();
  });
});
