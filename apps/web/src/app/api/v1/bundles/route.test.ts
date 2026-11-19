import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { BundlesService } from '@/server/services/bundles';
import { ServiceError } from '@/server/services/context';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/bundles', () => ({ BundlesService: vi.fn() }));

/**
 * GET /api/v1/bundles: the phone's bundle list (S16). A failure that is not a
 * ServiceError used to answer the error's own text and report nothing.
 */

function mockList(impl: () => Promise<unknown>) {
  const list = vi.fn(impl);
  vi.mocked(BundlesService).mockImplementation(function () {
    return { list } as unknown as InstanceType<typeof BundlesService>;
  });
  return list;
}

const request = () =>
  new Request('https://test.local/api/v1/bundles?q=kit') as unknown as Parameters<typeof GET>[0];

describe('GET /api/v1/bundles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      supabase: makeSupabaseStub({}).client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(['bundles']),
    });
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it('answers the bundles', async () => {
    const list = mockList(async () => [{ id: 'b-1' }]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bundles: [{ id: 'b-1' }] });
    expect(list).toHaveBeenCalledWith({ search: 'kit', includeInactive: false });
  });

  it('an unexpected error answers the fixed sentence, never its own text, and is reported', async () => {
    const err = new TypeError("Cannot read properties of null (reading 'bundle_components')");
    mockList(async () => {
      throw err;
    });
    const res = await GET(request());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('bundle_components');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.bundles.list',
      organizationId: 'org-1',
    });
  });
});

// A ServiceError keeps its code's status (serviceErrorStatus). A refusal is
// the caller's answer and is not reported; an internal_error answers the fixed
// sentence and is reported once, with the route's tag and organization id.
describe('GET /api/v1/bundles — a ServiceError answers by its code', () => {
  beforeEach(() => {
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      supabase: makeSupabaseStub({}).client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(['bundles']),
    });
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 60_000,
    });
  });

  it.each([
    ['module_disabled', 403],
    ['forbidden', 403],
    ['validation_error', 400],
    ['not_found', 404],
    ['conflict', 409],
  ] as const)('%s answers %i with its own words and is not reported', async (code, status) => {
    vi.mocked(reportError).mockClear();
    mockList(async () => {
      throw new ServiceError(code, 'Made-up refusal sentence.');
    });
    const res = await GET(request());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, message: 'Made-up refusal sentence.' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('internal_error answers the fixed sentence and is reported once with codes only', async () => {
    vi.mocked(reportError).mockClear();
    const err = new ServiceError('internal_error', 'relation "bundle_components" does not exist');
    mockList(async () => {
      throw err;
    });
    const res = await GET(request());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('bundle_components');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'api.v1.bundles.list',
      organizationId: 'org-1',
    });
  });
});
