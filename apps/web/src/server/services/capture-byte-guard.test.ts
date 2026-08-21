import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// SNIFF-BEFORE-WRITE — the server-side capture paths.
//
// These differ from the attachment finalizes in a way that makes them safer:
// the bytes pass THROUGH the server, so the guard runs before the upload
// rather than fetching the object back to verify it. Nothing unverified ever
// reaches storage.
//
// size-count-training is the largest object store in the system (2,174 objects
// at audit time) AND its contents are fed to a vision model as training data,
// so unverified bytes here are both a payload host and a poisoned corpus.
// ---------------------------------------------------------------------------
const { uploadMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async () => ({ data: { path: 'p' }, error: null })),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ storage: { from: () => ({ upload: uploadMock }) } })),
}));
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertModuleEnabled: vi.fn() };
});
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { ServiceError } from './context';
import { SizeCountsService } from './size-counts';

const ORG = '11111111-1111-4111-8111-111111111111';

function pngBytes(): ArrayBuffer {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, 2);
  new DataView(b.buffer).setUint32(20, 3);
  return b.buffer;
}
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0))).buffer;

function svc() {
  const stub = makeSupabaseStub({
    'size_count_training_samples.insert': { data: { id: 'sample-1' }, error: null },
  });
  return {
    stub,
    svc: new SizeCountsService(
      makeServiceContext(stub.client, { role: 'staff', organizationId: ORG }) as never,
    ),
  };
}

const input = (bytes: ArrayBuffer, mimeType = 'image/webp') => ({
  imageBytes: bytes,
  mimeType,
  sizeLabel: 'M',
});

beforeEach(() => vi.clearAllMocks());

describe('SizeCountsService.recordTrainingSample — sniff before write', () => {
  it.each([
    ['an HTML document', ascii('<!DOCTYPE html><script>alert(1)</script>')],
    ['an SVG carrying script', ascii('<svg onload="alert(1)"/>')],
    ['a Windows PE binary', new Uint8Array([0x4d, 0x5a, 0x90, 0x00]).buffer],
  ])('REJECTS %s declared as image/webp, and NEVER uploads it', async (_label, bytes) => {
    const { stub, svc: s } = svc();

    const err = await s.recordTrainingSample(input(bytes)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    // THE PROPERTY THAT MAKES THIS SHAPE BETTER than verify-or-delete: the
    // bytes never reached the bucket, so there is nothing to clean up and no
    // window in which they were reachable.
    expect(uploadMock).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('size_count_training_samples');
  });

  it('ACCEPTS real image bytes — the normal capture workflow still works', async () => {
    const { stub, svc: s } = svc();
    await expect(s.recordTrainingSample(input(pngBytes(), 'image/png'))).resolves.toEqual({
      id: 'sample-1',
    });
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(stub.fromCalls).toContain('size_count_training_samples');
  });

  it('stores the SNIFFED mime and extension, not the declared ones', async () => {
    // PNG bytes uploaded while declaring image/webp. Both the object path and
    // the stored content-type must follow the bytes, or storage later serves
    // the object as something it is not.
    const { svc: s } = svc();
    await s.recordTrainingSample(input(pngBytes(), 'image/webp'));
    const [path, , opts] = uploadMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { contentType: string },
    ];
    expect(path).toMatch(/\.png$/);
    expect(opts.contentType).toBe('image/png');
  });

  it('surfaces a user-safe message, not sniffer internals', async () => {
    const { svc: s } = svc();
    const err = await s
      .recordTrainingSample(input(ascii('<html/>')))
      .catch((e: unknown) => e);
    expect((err as ServiceError).message).toMatch(/failed our security checks/i);
    expect((err as ServiceError).message).not.toMatch(/magic|signature|sniff|webp/i);
  });
});
