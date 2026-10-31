import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/cycle-counts', () => ({ CycleCountsService: vi.fn() }));

/**
 * POST /api/cycle-counts/[id]/ai-scan/[scanId]/confirm: the AI shelf scan's
 * confirmed marker (S16). A refusal keeps its code and words; anything else
 * used to answer the error's own text and report nothing.
 */

const CC = '11111111-1111-4111-8111-111111111111';
const SCAN = '33333333-3333-4333-8333-333333333333';

function request() {
  return {
    req: new Request(`https://test.local/api/cycle-counts/${CC}/ai-scan/${SCAN}/confirm`, {
      method: 'POST',
    }) as unknown as Parameters<typeof POST>[0],
    params: { params: Promise.resolve({ id: CC, scanId: SCAN }) },
  };
}

function mockConfirm(impl: () => Promise<void>) {
  const markAiScanConfirmed = vi.fn(impl);
  vi.mocked(CycleCountsService).mockImplementation(function () {
    return { markAiScanConfirmed } as unknown as InstanceType<typeof CycleCountsService>;
  });
  return markAiScanConfirmed;
}

describe('POST /api/cycle-counts/[id]/ai-scan/[scanId]/confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withApiContext).mockResolvedValue({
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'staff' as const,
      supabase: makeSupabaseStub({}).client as never,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set<ModuleId>(['cycle_counts', 'ai_shelf_scan']),
    });
  });

  it('marks the scan confirmed', async () => {
    const confirm = mockConfirm(async () => {});
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith(SCAN);
  });

  it('a refusal keeps its code and its words', async () => {
    mockConfirm(async () => {
      throw new ServiceError('not_found', 'Scan not found or no longer editable.');
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'not_found',
      message: 'Scan not found or no longer editable.',
    });
  });

  it('an unexpected error answers the fixed sentence, never its own text, and is reported', async () => {
    const err = new Error(
      'new row violates row-level security policy for table "cycle_count_ai_scans"',
    );
    mockConfirm(async () => {
      throw err;
    });
    const { req, params } = request();
    const res = await POST(req, params);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'internal_error',
      message: 'Something went wrong. Please try again.',
    });
    expect(text).not.toContain('cycle_count_ai_scans');
    expect(reportError).toHaveBeenCalledWith(err, {
      tag: 'cycle_counts.ai_scan.confirm',
      organizationId: 'org-1',
    });
  });
});
