import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envState, removeMock, reportErrorMock, bucketsAsked } = vi.hoisted(() => ({
  envState: { NEXT_PUBLIC_SUPABASE_URL: 'https://supa.example.com/' as string | undefined },
  removeMock: vi.fn(async (_paths: string[]) => ({ data: [] as unknown, error: null as { message: string } | null })),
  reportErrorMock: vi.fn(async () => undefined),
  bucketsAsked: [] as string[],
}));

vi.mock('@/lib/env', () => ({ env: envState }));
vi.mock('@/lib/error-reporter', () => ({ reportError: reportErrorMock }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: (bucket: string) => {
        bucketsAsked.push(bucket);
        return { remove: removeMock };
      },
    },
  })),
}));

import { orgLogoObjectPath, removePreviousOrgLogo } from './org-logo-object';

const ORG = '0b5e6a52-1c1d-4c9e-9a51-6c0e2f6d7a10';
const OTHER_ORG = '7d0c2f4e-8a3b-4b61-9f20-1e5d3c7b9a42';
const BASE = 'https://supa.example.com/storage/v1/object/public/org-logos/';

beforeEach(() => {
  vi.clearAllMocks();
  bucketsAsked.length = 0;
  envState.NEXT_PUBLIC_SUPABASE_URL = 'https://supa.example.com/';
  removeMock.mockImplementation(async () => ({ data: [], error: null }));
});

describe('orgLogoObjectPath', () => {
  it('names the object of this organization logo link', () => {
    expect(orgLogoObjectPath(`${BASE}${ORG}/logo-1700000000000.png`, ORG)).toBe(`${ORG}/logo-1700000000000.png`);
    expect(orgLogoObjectPath(`${BASE}${ORG}/logo-1.webp?t=5`, ORG)).toBe(`${ORG}/logo-1.webp`);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['another organization', `${BASE}${OTHER_ORG}/logo-1.png`],
    ['another host', `https://cdn.example.org/storage/v1/object/public/org-logos/${ORG}/logo-1.png`],
    ['another bucket', `https://supa.example.com/storage/v1/object/public/user-avatars/${ORG}/logo-1.png`],
    ['a nested folder', `${BASE}${ORG}/a/logo-1.png`],
    ['a step out', `${BASE}${ORG}/../${OTHER_ORG}/logo-1.png`],
    ['an encoded step out', `${BASE}${ORG}/%2e%2e/logo-1.png`],
    ['the folder itself', `${BASE}${ORG}/`],
    ['a bare path', `${ORG}/logo-1.png`],
  ])('answers null for %s', (_l, value) => {
    expect(orgLogoObjectPath(value, ORG)).toBeNull();
  });

  it('answers null for everything when the storage address is not configured', () => {
    envState.NEXT_PUBLIC_SUPABASE_URL = undefined;
    expect(orgLogoObjectPath(`/storage/v1/object/public/org-logos/${ORG}/logo-1.png`, ORG)).toBeNull();
    expect(orgLogoObjectPath(`${BASE}${ORG}/logo-1.png`, ORG)).toBeNull();
  });
});

describe('removePreviousOrgLogo', () => {
  it('removes the previous object from the logo bucket', async () => {
    await removePreviousOrgLogo({
      organizationId: ORG,
      previousUrl: `${BASE}${ORG}/logo-1.png`,
      savedUrl: `${BASE}${ORG}/logo-2.png`,
    });
    expect(bucketsAsked).toEqual(['org-logos']);
    expect(removeMock).toHaveBeenCalledWith([`${ORG}/logo-1.png`]);
  });

  it('removes the previous object when the logo was cleared', async () => {
    await removePreviousOrgLogo({ organizationId: ORG, previousUrl: `${BASE}${ORG}/logo-1.png`, savedUrl: null });
    expect(removeMock).toHaveBeenCalledWith([`${ORG}/logo-1.png`]);
  });

  it('never removes the object the column now names', async () => {
    await removePreviousOrgLogo({
      organizationId: ORG,
      previousUrl: `${BASE}${ORG}/logo-1.png?t=1`,
      savedUrl: `${BASE}${ORG}/logo-1.png`,
    });
    expect(removeMock).not.toHaveBeenCalled();
    expect(bucketsAsked).toEqual([]);
  });

  it('removes nothing for a previous value outside the organization folder', async () => {
    await removePreviousOrgLogo({
      organizationId: ORG,
      previousUrl: `${BASE}${OTHER_ORG}/logo-1.png`,
      savedUrl: null,
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('reports an answered error with the organization only, and does not throw', async () => {
    removeMock.mockImplementation(async () => ({ data: null, error: { message: 'storage unavailable' } }));
    await expect(
      removePreviousOrgLogo({ organizationId: ORG, previousUrl: `${BASE}${ORG}/logo-1.png`, savedUrl: null }),
    ).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'org.logo.remove_previous',
      level: 'warning',
      extra: { organizationId: ORG, source: 'web' },
    });
    expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain('logo-1');
  });

  it('reports a thrown error and does not throw', async () => {
    removeMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    await expect(
      removePreviousOrgLogo({ organizationId: ORG, previousUrl: `${BASE}${ORG}/logo-1.png`, savedUrl: null }),
    ).resolves.toBeUndefined();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'org.logo.remove_previous' }),
    );
  });
});
