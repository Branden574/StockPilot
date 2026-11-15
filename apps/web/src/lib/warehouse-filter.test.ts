import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getWarehouseAccessFor } from '@/lib/auth/warehouse';

import { getActiveWarehouseFilterFor } from './warehouse-filter';

const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));
// requireOrgContext (the zero-arg fallback inside getWarehouseAccess) throws
// NEXT_REDIRECT outside a page render — the prod 500 this suite regressions.
// The ctx variant must NEVER reach it, which these tests prove by mocking
// getWarehouseAccessFor (no fallback) and asserting it always receives the
// caller's ctx.
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccessFor: vi.fn(),
}));

const CTX = { organizationId: 'org-1', userId: 'u-1', role: 'admin' };

function access(hasAllAccess: boolean, readableIds: string[]) {
  return {
    hasAllAccess,
    readableIds,
    writableIds: readableIds,
    primaryWarehouseId: readableIds[0] ?? null,
  };
}

describe('getActiveWarehouseFilterFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always passes the caller ctx to getWarehouseAccessFor (never the redirect-throwing zero-arg path)', async () => {
    vi.mocked(getWarehouseAccessFor).mockResolvedValue(access(true, ['wh-1']));
    cookieGet.mockReturnValue(undefined);

    await getActiveWarehouseFilterFor(CTX);

    expect(getWarehouseAccessFor).toHaveBeenCalledTimes(1);
    expect(getWarehouseAccessFor).toHaveBeenCalledWith(CTX);
  });

  it('returns the cookie warehouse when the manager can read it', async () => {
    vi.mocked(getWarehouseAccessFor).mockResolvedValue(access(true, ['wh-1', 'wh-2']));
    cookieGet.mockReturnValue({ value: 'wh-2' });

    await expect(getActiveWarehouseFilterFor(CTX)).resolves.toBe('wh-2');
  });

  it('returns null when the cookie points at a warehouse outside readableIds', async () => {
    vi.mocked(getWarehouseAccessFor).mockResolvedValue(access(true, ['wh-1']));
    cookieGet.mockReturnValue({ value: 'wh-999' });

    await expect(getActiveWarehouseFilterFor(CTX)).resolves.toBeNull();
  });

  it('returns null for warehouse-scoped users regardless of cookie', async () => {
    vi.mocked(getWarehouseAccessFor).mockResolvedValue(access(false, ['wh-1']));
    cookieGet.mockReturnValue({ value: 'wh-1' });

    await expect(getActiveWarehouseFilterFor(CTX)).resolves.toBeNull();
  });

  it('returns null with no cookie (Bearer callers carry none)', async () => {
    vi.mocked(getWarehouseAccessFor).mockResolvedValue(access(true, ['wh-1']));
    cookieGet.mockReturnValue(undefined);

    await expect(getActiveWarehouseFilterFor(CTX)).resolves.toBeNull();
  });
});
