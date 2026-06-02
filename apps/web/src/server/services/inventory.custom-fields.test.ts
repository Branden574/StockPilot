// apps/web/src/server/services/inventory.custom-fields.test.ts
//
// Server-side authoritative custom_fields validation on the item SAVE path.
// InventoryService.create / update call assertCustomFieldsValid BEFORE touching
// the DB: it loads the org's definitions (via CustomFieldsService.listDefinitions)
// and runs the pure validateCustomFields. A crafted payload that violates a
// definition (select value not in options / missing required / wrong type) must
// be rejected with a `validation_error` ServiceError — never persisted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

// assertPermission / assertPlanLimit run first in create(); make them no-ops so
// the test isolates the custom-fields gate. Keep a real ServiceError so the
// thrown `.code` is assertable.
vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(async () => undefined),
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { InventoryService } from './inventory';

/** One stored `custom_field_definitions` row, snake_case, as PostgREST returns. */
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
 * Build an InventoryService backed by a stub whose
 * custom_field_definitions.select resolves the given definition rows. The
 * insert spy lets us assert NOTHING was written when validation rejects.
 */
function makeService(defs: Record<string, unknown>[]) {
  const stub = makeSupabaseStub({
    'custom_field_definitions.select': { data: defs, error: null },
  });
  const insertSpy = vi.fn();
  const originalFrom = stub.client.from.bind(stub.client);
  stub.client.from = vi.fn((table: string) => {
    const chain = originalFrom(table);
    return new Proxy(chain as object, {
      get(target, prop: string) {
        if (prop === 'insert') {
          return (...args: unknown[]) => {
            insertSpy(...args);
            return (target as Record<string, unknown>).insert as unknown;
          };
        }
        return (target as Record<string, unknown>)[prop];
      },
    });
  });
  const ctx = {
    supabase: stub.client,
    organizationId: 'org-1',
    userId: 'user-1',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ConstructorParameters<typeof InventoryService>[0];
  return { svc: new InventoryService(ctx), insertSpy, stub };
}

type CreateArg = Parameters<InventoryService['create']>[0];

// The create() gate only reads input.customFields before it would reach the
// (unmocked) insert path, so a partial object cast to the full input type is
// sufficient to exercise assertCustomFieldsValid.
function input(customFields: Record<string, unknown>): CreateArg {
  return {
    name: 'Test item',
    itemType: 'product',
    warehouseId: 'wh-1',
    quantity: 1,
    customFields,
  } as unknown as CreateArg;
}

describe('InventoryService.create — server-side custom_fields validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a select value that is not one of the definition options', async () => {
    const { svc, insertSpy } = makeService([
      defRow({
        field_key: 'condition',
        field_type: 'select',
        options: [
          { value: 'new', label: 'New' },
          { value: 'used', label: 'Used' },
        ],
      }),
    ]);

    await expect(
      svc.create(input({ condition: 'refurbished' })),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing REQUIRED field', async () => {
    const { svc, insertSpy } = makeService([
      defRow({ field_key: 'serial_no', field_type: 'text', required: true }),
    ]);

    // A non-empty custom_fields object that omits the required key.
    await expect(
      svc.create(input({ unrelated: 'x' })),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects a wrong-type value (text where a number is defined)', async () => {
    const { svc, insertSpy } = makeService([
      defRow({ field_key: 'warranty_months', field_type: 'number' }),
    ]);

    await expect(
      svc.create(input({ warranty_months: 'not-a-number' })),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  // The two "passes the gate" cases below let create() proceed PAST
  // assertCustomFieldsValid. We don't mock the full insert path, so create()
  // ultimately fails on the stub insert — but the point is only that the
  // custom-fields gate did NOT raise our `validation_error`. assertCodeIsNot
  // catches any thrown error and fails the test only if it is our gate code.
  async function assertGatePasses(p: Promise<unknown>) {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    // If the gate had rejected, it would be a ServiceError with this code.
    if (thrown && (thrown as { code?: string }).code === 'validation_error') {
      throw new Error('expected the custom-fields gate to pass, but it rejected');
    }
  }

  it('does NOT reject when there are no definitions for the org (cheap no-op)', async () => {
    const { svc } = makeService([]);
    await assertGatePasses(
      svc.create(input({ anything: 'goes' })),
    );
  });

  it('does NOT reject an unknown stray key that has no definition', async () => {
    const { svc } = makeService([
      defRow({ field_key: 'warranty_months', field_type: 'number' }),
    ]);
    // warranty_months is valid, and `notes` has no definition so it is left
    // untouched — the gate must let this through.
    await assertGatePasses(
      svc.create(input({ warranty_months: 12, notes: 'free text' })),
    );
  });
});
