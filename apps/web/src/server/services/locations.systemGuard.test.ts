import { describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn() }));

import { ServiceError, type ServiceContext } from './context';
import { LocationsService } from './locations';

// ---------------------------------------------------------------------------
// Staging/Unplaced (kind staging|unplaced) are auto-created per warehouse and
// receiving routes stock through them. archive() must refuse them server-side
// — the UI hides the button, but the service is the real gate.
// ---------------------------------------------------------------------------

function makeService(row: { id: string; kind: string | null } | null): {
  svc: LocationsService;
  stub: SupabaseStub;
} {
  const stub = makeSupabaseStub({
    'locations.select': { data: row, error: null },
    'locations.update': { data: row ? { id: row.id } : null, error: null },
  });
  const ctx = {
    supabase: stub.client,
    organizationId: 'org-test',
    userId: 'user-test',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  } as unknown as ServiceContext;
  return { svc: new LocationsService(ctx), stub };
}

describe('LocationsService.archive — system locations are refused', () => {
  it.each(['staging', 'unplaced'] as const)('refuses to archive a %s bucket', async (kind) => {
    const { svc, stub } = makeService({ id: 'loc-sys', kind });
    const err = await svc
      .archive('loc-sys')
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('validation_error');
    // The soft-delete update never ran.
    expect(stub.chains.get('locations.update')).toBeUndefined();
  });

  it('still archives a normal location', async () => {
    const { svc, stub } = makeService({ id: 'loc-rack', kind: 'rack' });
    await expect(svc.archive('loc-rack')).resolves.toBeUndefined();
    expect(stub.chains.get('locations.update')).toBeDefined();
  });
});
