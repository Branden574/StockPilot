import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

import type { CustomFieldDefinition } from '@stockpilot/core';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session/MFA state so per-test role + AAL overrides work (mirrors
// nav-settings.test.ts / dashboard-settings.test.ts).
const sessionState = {
  role: 'owner' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
};

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = {
  stub: null,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      supabase: stubHolder.stub!.client,
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(),
    })),
  };
});

import { audit } from '@/server/services/audit';

import {
  archiveCustomFieldAction,
  createCustomFieldAction,
  updateCustomFieldAction,
} from './custom-fields';

/**
 * A `custom_field_definitions` ROW (snake_case) as PostgREST returns it. The
 * service's create/update/archive all `.select(...).single()` the persisted
 * row, so the insert/update result must look like a row.
 */
function defRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    organization_id: 'org-1',
    entity: 'item',
    field_key: 'warranty_months',
    label: 'Warranty (months)',
    field_type: 'number',
    options: null,
    required: false,
    sort_order: 0,
    archived: false,
    ...overrides,
  };
}

/**
 * Build a stub that records the custom_field_definitions insert/update payload
 * and resolves the persisted row. Mirrors the `stubWithUpdateSpy` helper in the
 * sibling settings-action tests, but for an insert/update→single() row table.
 */
function stubWithRow(row: Record<string, unknown>) {
  const insertSpy = vi.fn((..._args: unknown[]) => ({
    select: vi.fn(() => ({
      single: vi.fn(async () => ({ data: row, error: null })),
    })),
  }));
  const updateSpy = vi.fn((..._args: unknown[]) => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: row, error: null })),
        })),
      })),
    })),
  }));
  const stub = makeSupabaseStub();
  const originalFrom = stub.client.from.bind(stub.client);
  stub.client.from = vi.fn((table: string) => {
    const chain = originalFrom(table);
    if (table === 'custom_field_definitions') {
      return new Proxy(chain as object, {
        get(target, prop: string) {
          if (prop === 'insert') return insertSpy;
          if (prop === 'update') return updateSpy;
          return (target as Record<string, unknown>)[prop];
        },
      });
    }
    return chain;
  });
  return { stub, insertSpy, updateSpy };
}

describe('createCustomFieldAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('returns forbidden for a non-admin (staff) role, no write', async () => {
    sessionState.role = 'staff';
    const { stub, insertSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'warranty_months',
      label: 'Warranty (months)',
      fieldType: 'number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(insertSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.role = 'owner';
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const { stub, insertSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'warranty_months',
      label: 'Warranty (months)',
      fieldType: 'number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(insertSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an unknown field_type as validation_error, no write', async () => {
    const { stub, insertSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'warranty_months',
      label: 'Warranty',
      // deliberately bad type to exercise the zod enum reject
      fieldType: 'currency' as 'text',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects a select with no options as validation_error, no write', async () => {
    const { stub, insertSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'condition',
      label: 'Condition',
      fieldType: 'select',
      options: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-snake_case field_key as validation_error, no write', async () => {
    const { stub, insertSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'Warranty Months',
      label: 'Warranty',
      fieldType: 'number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects a reserved field_key (size) as validation_error, no write', async () => {
    const { stub, insertSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'size',
      label: 'Size',
      fieldType: 'text',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('persists a valid definition, audits, and round-trips the row', async () => {
    const row = defRow();
    const { stub, insertSpy } = stubWithRow(row);
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'warranty_months',
      label: 'Warranty (months)',
      fieldType: 'number',
      required: false,
      sortOrder: 0,
    });
    expect(result.ok).toBe(true);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const payload = insertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.organization_id).toBe('org-1');
    expect(payload.field_key).toBe('warranty_months');
    expect(payload.field_type).toBe('number');
    // select fields persist null options on a non-select.
    expect(payload.options).toBeNull();
    if (result.ok) {
      const def: CustomFieldDefinition = result.data.definition;
      expect(def.fieldKey).toBe('warranty_months');
      expect(def.fieldType).toBe('number');
      expect(def.organizationId).toBe('org-1');
    }
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('custom_field_definition.created');
  });

  it('persists a select definition with its options', async () => {
    const row = defRow({
      field_key: 'condition',
      label: 'Condition',
      field_type: 'select',
      options: [
        { value: 'new', label: 'New' },
        { value: 'used', label: 'Used' },
      ],
    });
    const { stub, insertSpy } = stubWithRow(row);
    stubHolder.stub = stub;

    const result = await createCustomFieldAction({
      fieldKey: 'condition',
      label: 'Condition',
      fieldType: 'select',
      options: [
        { value: 'new', label: 'New' },
        { value: 'used', label: 'Used' },
      ],
    });
    expect(result.ok).toBe(true);
    const payload = insertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.field_type).toBe('select');
    expect(payload.options).toEqual([
      { value: 'new', label: 'New' },
      { value: 'used', label: 'Used' },
    ]);
  });
});

describe('updateCustomFieldAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('returns forbidden for a non-admin (staff) role, no write', async () => {
    sessionState.role = 'staff';
    const { stub, updateSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await updateCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
      label: 'Renamed',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.role = 'owner';
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const { stub, updateSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await updateCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
      label: 'Renamed',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id as validation_error, no write', async () => {
    const { stub, updateSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await updateCustomFieldAction({
      id: 'not-a-uuid',
      label: 'Renamed',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rejects switching a field to select with no options, no write', async () => {
    const { stub, updateSpy } = stubWithRow(defRow());
    stubHolder.stub = stub;

    const result = await updateCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
      fieldType: 'select',
      options: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('persists a valid label change, audits, round-trips the row', async () => {
    const row = defRow({ label: 'Renamed' });
    const { stub, updateSpy } = stubWithRow(row);
    stubHolder.stub = stub;

    const result = await updateCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
      label: 'Renamed',
    });
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.label).toBe('Renamed');
    if (result.ok) expect(result.data.definition.label).toBe('Renamed');
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('custom_field_definition.updated');
  });
});

describe('archiveCustomFieldAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.role = 'owner';
    sessionState.mfaRequired = false;
    sessionState.mfaSatisfied = true;
    stubHolder.stub = null;
  });

  it('returns forbidden for a non-admin (staff) role, no write', async () => {
    sessionState.role = 'staff';
    const { stub, updateSpy } = stubWithRow(defRow({ archived: true }));
    stubHolder.stub = stub;

    const result = await archiveCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects an AAL1 session when the org requires MFA (forbidden, no write)', async () => {
    sessionState.role = 'owner';
    sessionState.mfaRequired = true;
    sessionState.mfaSatisfied = false;
    const { stub, updateSpy } = stubWithRow(defRow({ archived: true }));
    stubHolder.stub = stub;

    const result = await archiveCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('archives (default true), audits the new archived state, round-trips', async () => {
    const row = defRow({ archived: true });
    const { stub, updateSpy } = stubWithRow(row);
    stubHolder.stub = stub;

    const result = await archiveCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const payload = updateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.archived).toBe(true);
    if (result.ok) expect(result.data.definition.archived).toBe(true);
    expect(vi.mocked(audit).mock.calls[0]?.[0].event).toBe('custom_field_definition.archived');
  });

  it('un-archives when archived:false is passed', async () => {
    const row = defRow({ archived: false });
    const { stub, updateSpy } = stubWithRow(row);
    stubHolder.stub = stub;

    const result = await archiveCustomFieldAction({
      id: '11111111-1111-1111-1111-111111111111',
      archived: false,
    });
    expect(result.ok).toBe(true);
    const payload = updateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.archived).toBe(false);
  });
});
