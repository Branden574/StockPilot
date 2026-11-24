import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import {
  arrayBufferOf,
  expectOneRefusal,
  HTML_PAGE,
  JPEG_WITH_ARCHIVE,
  PNG_WITH_ARCHIVE,
  TINY_JPEG,
  TINY_PNG,
} from '@/test/upload-fixtures';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): the four paths whose photo passes
// THROUGH the server go through the one upload check, before storage and
// before any model sees the photo:
//   - the cycle-count shelf scan (POST /api/cycle-counts/[id]/ai-scan),
//   - the size-count scan (POST /api/v1/size-counts/[id]/scan),
//   - the size-count training sample (SizeCountsService.recordTrainingSample),
//   - identify-from-photo (POST /api/v1/ai/identify-from-photo), which only
//     sniffed before and now also looks for a file hidden after the picture.
// A refused photo: the same answer as before, nothing stored, nothing sent to
// a model, and exactly one malware / blocked event in the organization with
// no file name. A clean photo: the same bytes reach storage or the model
// under the type its bytes say. A recorder that fails changes neither.
// Tiny made-up files only (test/upload-fixtures.ts).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  createSignedUrl: vi.fn(),
  envOverrides: {} as Record<string, string | undefined>,
}));

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/lib/api-read-context', () => ({ apiReadContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/ai/claude', () => ({ claudeGenerateJsonString: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    storage: { from: () => ({ upload: h.upload, createSignedUrl: h.createSignedUrl }) },
  })),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    throw new Error('outside a request');
  }),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return { ...actual, assertPermission: vi.fn(), assertModuleEnabled: vi.fn() };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  const proxied = new Proxy(actual.env as Record<string, unknown>, {
    get: (target, prop: string) =>
      prop in h.envOverrides ? h.envOverrides[prop] : target[prop],
  });
  return { ...actual, env: proxied };
});

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { apiReadContext } from '@/server/lib/api-read-context';
import { recordSecurityEvent } from '@/server/security/events';
import { CycleCountsService } from '@/server/services/cycle-counts';
import { SizeCountsService } from '@/server/services/size-counts';

import { POST as cycleCountScan } from '@/app/api/cycle-counts/[id]/ai-scan/route';
import { POST as identifyFromPhoto } from '@/app/api/v1/ai/identify-from-photo/route';
import { POST as sizeCountScan } from '@/app/api/v1/size-counts/[id]/scan/route';

const record = vi.mocked(recordSecurityEvent);
const claude = vi.mocked(claudeGenerateJsonString);
const ORG = '11111111-1111-4111-8111-111111111111';
const COUNT = '22222222-2222-4222-8222-222222222222';
/** The file's name: never in what is recorded. */
const NAME = 'shelf-of-a-secret-customer.jpg';

const ctx = (enabled: ModuleId[]) => ({
  organizationId: ORG,
  userId: 'u-1',
  role: 'staff' as const,
  supabase: makeSupabaseStub({}).client as never,
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<ModuleId>(enabled),
});

function multipart(url: string, bytes: Uint8Array, type: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('image', new File([arrayBufferOf(bytes)], NAME, { type }));
  return new Request(url, { method: 'POST', body: form, headers }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  record.mockImplementation(async () => undefined);
  h.envOverrides = {
    GEMINI_API_KEY: 'configured-in-test',
    GEMINI_MODEL: 'test-model',
    ANTHROPIC_API_KEY: 'configured-in-test',
    ANTHROPIC_SIZE_SCAN_MODEL: 'test-model',
    AI_PROVIDER: 'claude',
  };
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 } as never);
  // A clean photo goes on to storage, which answers a failure: the test then
  // reads exactly what was handed to it, and nothing further runs.
  h.upload.mockResolvedValue({ data: null, error: { message: 'stopped here by the test' } });
  claude.mockRejectedValue(new Error('stopped here by the test'));
});

describe('the cycle-count shelf scan', () => {
  beforeEach(() => {
    vi.mocked(withApiContext).mockResolvedValue(ctx(['cycle_counts', 'ai_shelf_scan']) as never);
    vi.spyOn(CycleCountsService.prototype, 'getLineSetForAiScan').mockResolvedValue([
      { lineId: 'l-1', sku: 'SKU-1', name: 'A made-up title' },
    ] as never);
  });
  const post = (bytes: Uint8Array, type = 'image/jpeg', headers: Record<string, string> = {}) =>
    cycleCountScan(multipart(`https://test.local/api/cycle-counts/${COUNT}/ai-scan`, bytes, type, headers), {
      params: Promise.resolve({ id: COUNT }),
    });

  it('a clean photo reaches storage byte for byte, under the type its bytes say, recording nothing', async () => {
    const res = await post(TINY_PNG, 'image/jpeg');
    expect(res.status).toBe(502); // the test's storage stop, after the check
    expect(h.upload).toHaveBeenCalledTimes(1);
    const [, body, opts] = h.upload.mock.calls[0]! as [string, ArrayBuffer, { contentType: string }];
    expect(new Uint8Array(body)).toEqual(TINY_PNG);
    expect(opts.contentType).toBe('image/png');
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a photo', HTML_PAGE, 'upload_wrong_type', /failed our security checks/],
    ['an archive after the picture', JPEG_WITH_ARCHIVE, 'upload_hidden_file', /hidden|another file|after/i],
  ])('%s: 422, nothing stored, one event without the name', async (_what, bytes, reason, sentence) => {
    const res = await post(bytes);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_image');
    expect(body.message).toMatch(sentence);
    expect(h.upload).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason, organizationId: ORG }, [NAME, 'secret']);
  });

  it('a phone request is recorded as the phone', async () => {
    await post(HTML_PAGE, 'image/jpeg', { authorization: 'Bearer phone-token' });
    expectOneRefusal(record, { reason: 'upload_wrong_type', organizationId: ORG, source: 'phone' });
  });

  it('a recorder that fails: the refusal stands, and a clean photo still goes through', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    expect((await post(HTML_PAGE)).status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
    expect((await post(TINY_JPEG)).status).toBe(502);
    expect(h.upload).toHaveBeenCalledTimes(1);
  });
});

describe('the size-count scan', () => {
  beforeEach(() => {
    vi.mocked(apiReadContext).mockResolvedValue({ ctx: ctx(['instant_size_count']) } as never);
    vi.spyOn(SizeCountsService.prototype, 'getScanContext').mockResolvedValue({
      allowedSizes: ['M'],
      groupName: null,
    });
  });
  const post = (bytes: Uint8Array, type = 'image/jpeg') =>
    sizeCountScan(multipart(`https://test.local/api/v1/size-counts/${COUNT}/scan`, bytes, type), {
      params: Promise.resolve({ id: COUNT }),
    });

  it('a clean photo reaches the model byte for byte, under the type its bytes say, recording nothing', async () => {
    const res = await post(TINY_PNG, 'image/webp');
    expect(res.status).toBe(502); // the test's model stop, after the check
    expect(claude).toHaveBeenCalledTimes(1);
    const media = claude.mock.calls[0]![0].media![0]!;
    expect(media.mediaType).toBe('image/png');
    expect(Buffer.from(media.data, 'base64')).toEqual(Buffer.from(TINY_PNG));
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a photo', HTML_PAGE, 'upload_wrong_type'],
    ['an archive after the picture', PNG_WITH_ARCHIVE, 'upload_hidden_file'],
  ])('%s: 422, no model call, one event without the name', async (_what, bytes, reason) => {
    const res = await post(bytes);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_image');
    expect(claude).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason, organizationId: ORG }, [NAME]);
  });

  it('a recorder that fails: the refusal stands', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    expect((await post(HTML_PAGE)).status).toBe(422);
    expect(claude).not.toHaveBeenCalled();
  });
});

describe('the size-count training sample', () => {
  function service() {
    const stub = makeSupabaseStub({
      'size_count_training_samples.insert': { data: { id: 'sample-1' }, error: null },
    });
    return new SizeCountsService(
      makeServiceContext(stub.client, { role: 'staff', organizationId: ORG }) as never,
    );
  }
  const input = (bytes: Uint8Array, mimeType = 'image/webp') => ({
    imageBytes: arrayBufferOf(bytes),
    mimeType,
    sizeLabel: 'M',
  });

  it('a clean photo is stored byte for byte, recording nothing', async () => {
    h.upload.mockResolvedValue({ data: { path: 'p' }, error: null });
    await expect(service().recordTrainingSample(input(TINY_PNG))).resolves.toEqual({ id: 'sample-1' });
    const [path, body, opts] = h.upload.mock.calls[0]! as [string, Uint8Array | ArrayBuffer, { contentType: string }];
    expect(path).toMatch(/\.png$/);
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(TINY_PNG);
    expect(opts.contentType).toBe('image/png');
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a photo', HTML_PAGE, 'upload_wrong_type'],
    ['an archive after the picture', PNG_WITH_ARCHIVE, 'upload_hidden_file'],
  ])('%s: refused, nothing stored, one event', async (_what, bytes, reason) => {
    await expect(service().recordTrainingSample(input(bytes))).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(h.upload).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason, organizationId: ORG });
  });

  it('a recorder that fails: the refusal stands', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    await expect(service().recordTrainingSample(input(HTML_PAGE))).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(h.upload).not.toHaveBeenCalled();
  });
});

describe('identify-from-photo', () => {
  beforeEach(() => {
    vi.mocked(withApiContext).mockResolvedValue(ctx(['ai', 'inventory']) as never);
  });
  const postJson = (bytes: Uint8Array, mimeType = 'image/jpeg') =>
    identifyFromPhoto(
      new Request('https://test.local/api/v1/ai/identify-from-photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: Buffer.from(bytes).toString('base64'), mimeType }),
      }) as never,
    );

  it('a clean photo reaches the model byte for byte, under the type its bytes say, recording nothing', async () => {
    claude.mockResolvedValue(JSON.stringify({ kind: 'book', title: 'A made-up title', confidence: 'high' }));
    const res = await postJson(TINY_JPEG, 'image/png');
    expect(res.status).toBe(200);
    const media = claude.mock.calls[0]![0].media![0]!;
    expect(media.mediaType).toBe('image/jpeg');
    expect(Buffer.from(media.data, 'base64')).toEqual(Buffer.from(TINY_JPEG));
    expect(record).not.toHaveBeenCalled();
  });

  it('a web page called a photo: the same 422 and sentence as before, and one event', async () => {
    const res = await postJson(HTML_PAGE);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'invalid_image',
      message: 'That photo could not be read as an image.',
    });
    expect(claude).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason: 'upload_wrong_type', organizationId: ORG });
  });

  it('NEW here: an archive after the picture is refused as a hidden file, before the model', async () => {
    const res = await identifyFromPhoto(
      multipart('https://test.local/api/v1/ai/identify-from-photo', JPEG_WITH_ARCHIVE, 'image/jpeg'),
    );
    expect(res.status).toBe(422);
    expect(claude).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason: 'upload_hidden_file', organizationId: ORG }, [NAME]);
  });

  it('a recorder that fails: the refusal stands', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    expect((await postJson(HTML_PAGE)).status).toBe(422);
    expect(claude).not.toHaveBeenCalled();
  });
});
