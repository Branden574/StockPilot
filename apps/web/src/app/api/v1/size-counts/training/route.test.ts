import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { SizeCountsService } from '@/server/services/size-counts';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/server/services/size-counts', () => ({ SizeCountsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
    ...overrides,
  };
}

/** One multipart upload, exactly as the Expo capture screen sends it. */
function buildRequest(fields: Record<string, string>) {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'a.jpg');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('https://test.local/api/v1/size-counts/training', {
    method: 'POST',
    body: form,
  }) as unknown as Parameters<typeof POST>[0];
}

const recordTrainingSample = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(buildCtx() as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: Date.now() + 1000 } as never);
  recordTrainingSample.mockResolvedValue({ id: 'sample-1' });
  vi.mocked(SizeCountsService).mockImplementation(
    () => ({ recordTrainingSample }) as unknown as SizeCountsService,
  );
});

describe('POST /api/v1/size-counts/training — apparel labels still work', () => {
  it.each(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL'])(
    'accepts %s and stores it unchanged',
    async (label) => {
      const res = await POST(buildRequest({ sizeLabel: label }));
      expect(res.status).toBe(200);
      expect(recordTrainingSample).toHaveBeenCalledWith(
        expect.objectContaining({ sizeLabel: label, isNegative: false }),
      );
    },
  );

  it('still flags NONE as a hard negative', async () => {
    const res = await POST(buildRequest({ sizeLabel: 'NONE' }));
    expect(res.status).toBe(200);
    expect(recordTrainingSample).toHaveBeenCalledWith(
      expect.objectContaining({ sizeLabel: 'NONE', isNegative: true }),
    );
  });

  it('still honours an explicit isNegative flag on a sized label', async () => {
    await POST(buildRequest({ sizeLabel: 'L', isNegative: 'true' }));
    expect(recordTrainingSample).toHaveBeenCalledWith(
      expect.objectContaining({ sizeLabel: 'L', isNegative: true }),
    );
  });
});

describe('POST /api/v1/size-counts/training — numeric shoe sizes', () => {
  it.each(['1', '4.5', '9', '9.5', '10', '10.5', '13.5', '18'])(
    'accepts the shoe size %s',
    async (label) => {
      const res = await POST(buildRequest({ sizeLabel: label }));
      expect(res.status).toBe(200);
      expect(recordTrainingSample).toHaveBeenCalledWith(
        expect.objectContaining({ sizeLabel: label, isNegative: false }),
      );
    },
  );

  it('round-trips 9.5 without rounding it to 9 or 10', async () => {
    await POST(buildRequest({ sizeLabel: '9.5' }));
    expect(recordTrainingSample.mock.calls[0]?.[0]?.sizeLabel).toBe('9.5');
  });

  it('canonicalises a sloppy numeric so one size is not two training classes', async () => {
    await POST(buildRequest({ sizeLabel: '9.0' }));
    expect(recordTrainingSample).toHaveBeenCalledWith(
      expect.objectContaining({ sizeLabel: '9' }),
    );
  });

  it('still lower-cases-to-upper for alpha, as the old route did', async () => {
    await POST(buildRequest({ sizeLabel: 'xl' }));
    expect(recordTrainingSample).toHaveBeenCalledWith(
      expect.objectContaining({ sizeLabel: 'XL' }),
    );
  });
});

describe('POST /api/v1/size-counts/training — garbage is refused with a 400', () => {
  it.each(['9.55', '9.', 'abc', '', '0', '21', '20.5', 'XXXXXXL', '-9'])(
    'refuses %j',
    async (label) => {
      const res = await POST(buildRequest({ sizeLabel: label }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(expect.objectContaining({ error: 'invalid sizeLabel' }));
      expect(recordTrainingSample).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing sizeLabel', async () => {
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(400);
    expect(recordTrainingSample).not.toHaveBeenCalled();
  });
});
