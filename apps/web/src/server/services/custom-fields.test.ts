// apps/web/src/server/services/custom-fields.test.ts
//
// listDefinitions must FAIL CLOSED on a read error. If
// `custom_field_definitions` is missing (migration 0159 not applied) or any
// SELECT error occurs, throwing would crash every page that lists custom
// fields AND the item create/update WRITE path. The service logs and returns
// [] instead (mirrors getModulesForRequest). Writes still throw.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { CustomFieldsService } from './custom-fields';
import { ServiceError } from './context';

describe('CustomFieldsService.listDefinitions — fail closed on read error', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] (not throw) when the table read errors (relation does not exist)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = makeSupabaseStub({
      'custom_field_definitions.select': {
        data: null,
        error: { message: 'relation does not exist' },
      },
    });
    const svc = new CustomFieldsService(makeServiceContext(stub.client));

    const result = await svc.listDefinitions('item');
    expect(result).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns mapped definitions on a successful read', async () => {
    const stub = makeSupabaseStub({
      'custom_field_definitions.select': {
        data: [
          {
            id: 'cf-1',
            organization_id: 'org-test',
            entity: 'item',
            field_key: 'warranty_months',
            label: 'Warranty (months)',
            field_type: 'number',
            options: null,
            required: false,
            sort_order: 0,
            archived: false,
          },
        ],
        error: null,
      },
    });
    const svc = new CustomFieldsService(makeServiceContext(stub.client));

    const result = await svc.listDefinitions('item');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'cf-1', fieldKey: 'warranty_months' });
  });

  it('createDefinition still THROWS on a write error (writes are not fail-closed)', async () => {
    const stub = makeSupabaseStub({
      'custom_field_definitions.insert': {
        data: null,
        error: { message: 'relation does not exist' },
      },
    });
    const svc = new CustomFieldsService(
      makeServiceContext(stub.client, { role: 'admin' }),
    );

    await expect(
      svc.createDefinition({
        fieldKey: 'warranty_months',
        label: 'Warranty',
        fieldType: 'number',
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
