import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): the web finalize of an item photo
// (ItemImagesService.record) goes through the one upload check, for the
// master and for its thumbnail. A refusal removes BOTH objects, writes no
// row, answers a plain sentence, and records exactly one malware / blocked
// event in the organization with no path. A thumbnail that was never
// uploaded is still "no thumbnail", not a refusal. A clean photo records
// its row exactly as before. Tiny made-up files only.
// ---------------------------------------------------------------------------

const { fetchObjectWindowMock, fetchObjectWholeMock, stillNamedMock, checkRateLimitMock } = vi.hoisted(() => ({
  fetchObjectWindowMock: vi.fn(),
  fetchObjectWholeMock: vi.fn(),
  stillNamedMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectWindow: fetchObjectWindowMock,
  fetchObjectWhole: fetchObjectWholeMock,
}));
vi.mock('@/server/services/upload-still-named', () => ({ uploadObjectsStillNamed: stillNamedMock }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    throw new Error('outside a request');
  }),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn() };
});

import { THREAT_MESSAGES } from '@/lib/document-threat-scan';
import { ITEM_IMAGE_MAX_BYTES } from '@/lib/upload-size-limits';
import { recordSecurityEvent } from '@/server/security/events';
import { UPLOAD_TOO_LARGE_MESSAGE, UPLOAD_WRONG_TYPE_MESSAGE } from '@/server/security/upload-checks';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import {
  expectOneRefusal,
  HTML_PAGE,
  PNG_WITH_ARCHIVE,
  TINY_JPEG,
  TINY_PNG,
} from '@/test/upload-fixtures';

import { audit } from './audit';
import { ItemImagesService } from './item-images';

const record = vi.mocked(recordSecurityEvent);
const ORG = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const MASTER = `${ORG}/items/${ITEM}/33333333-3333-4333-8333-333333333333.jpg`;
const THUMB = `${ORG}/items/${ITEM}/33333333-3333-4333-8333-333333333333-thumb.webp`;

/**
 * Storage as the check reads it: a window of the first `window` bytes and
 * the size storage states (`sizes` overrides it, for an object too large to
 * build here), refused from that size when it is over the read's ceiling;
 * and a whole read of exactly the stated size.
 */
function world(objects: Record<string, Uint8Array | null>, window = 4096, sizes: Record<string, number> = {}) {
  const stub = makeSupabaseStub({
    'inventory_items.select': { data: { id: ITEM }, error: null },
    'item_images.insert': {
      data: { id: 'img-1', storage_path: MASTER, sort_order: 0, is_primary: true },
      error: null,
    },
  });
  const remove = vi.fn(async () => ({ data: null, error: null }));
  stub.client.storage.from = vi.fn(() => ({ remove, createSignedUrl: vi.fn() })) as never;
  fetchObjectWindowMock.mockImplementation(
    async (_bucket: unknown, path: string, _fetch: unknown, limit?: { maxTotalBytes?: number }) => {
      const body = objects[path];
      if (!body) return null;
      const total = sizes[path] ?? body.byteLength;
      if (limit?.maxTotalBytes !== undefined && total > limit.maxTotalBytes) {
        return { prefix: new Uint8Array(0), totalSize: total, overLimit: true };
      }
      return { prefix: body.subarray(0, window), totalSize: total };
    },
  );
  fetchObjectWholeMock.mockImplementation(async (_bucket: unknown, path: string, size: number) => {
    const body = objects[path];
    return body && body.byteLength === size ? body : null;
  });
  const svc = new ItemImagesService(makeServiceContext(stub.client, { organizationId: ORG }) as never);
  return { stub, svc, remove, whole: fetchObjectWholeMock };
}

const inserted = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.chainArgs.get('item_images.insert')?.[0]?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  record.mockImplementation(async () => undefined);
  stillNamedMock.mockResolvedValue(false);
  checkRateLimitMock.mockResolvedValue({ allowed: true, failed: false });
});

const removalLines = () =>
  vi.mocked(audit).mock.calls.filter(([p]) => p.event === 'security.upload_refused_removed');

describe('item photo finalize', () => {
  it('a clean master and thumbnail: the row as before, nothing removed, nothing recorded', async () => {
    const { stub, svc, remove } = world({ [MASTER]: TINY_JPEG, [THUMB]: TINY_PNG });
    await svc.record(ITEM, MASTER, true, { thumbPath: THUMB });
    expect(inserted(stub)).toMatchObject({ storage_path: MASTER, thumb_path: THUMB, is_primary: true });
    expect(remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a master larger than the first look is read whole, exactly its stated size, and still passes', async () => {
    const { stub, svc, whole } = world({ [MASTER]: TINY_PNG }, 30);
    await svc.record(ITEM, MASTER, false);
    expect(whole).toHaveBeenCalledWith(expect.anything(), MASTER, TINY_PNG.byteLength);
    expect(inserted(stub)).toMatchObject({ storage_path: MASTER, thumb_path: null });
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a photo', HTML_PAGE, 'upload_wrong_type', UPLOAD_WRONG_TYPE_MESSAGE],
    ['an archive after the picture', PNG_WITH_ARCHIVE, 'upload_hidden_file', THREAT_MESSAGES.appended_payload],
  ])('the master is %s: both removed, no row, a plain sentence, one event', async (_what, body, reason, sentence) => {
    const { stub, svc, remove } = world({ [MASTER]: body, [THUMB]: TINY_PNG });
    await expect(svc.record(ITEM, MASTER, true, { thumbPath: THUMB })).rejects.toMatchObject({
      code: 'validation_error',
      message: sentence,
    });
    expect(remove).toHaveBeenCalledWith([MASTER, THUMB]);
    expect(stub.chains.has('item_images.insert')).toBe(false);
    expectOneRefusal(record, { reason, organizationId: ORG }, [MASTER, ITEM, 'items/']);
  });

  it('the thumbnail is an archive after a picture: both removed, no row, one event', async () => {
    const { stub, svc, remove } = world({ [MASTER]: TINY_JPEG, [THUMB]: PNG_WITH_ARCHIVE });
    await expect(svc.record(ITEM, MASTER, true, { thumbPath: THUMB })).rejects.toMatchObject({
      message: THREAT_MESSAGES.appended_payload,
    });
    expect(remove).toHaveBeenCalledWith([MASTER, THUMB]);
    expect(stub.chains.has('item_images.insert')).toBe(false);
    expectOneRefusal(record, { reason: 'upload_hidden_file', organizationId: ORG }, [THUMB]);
  });

  it('a thumbnail never uploaded is "no thumbnail": the row without it, nothing removed or recorded', async () => {
    const { stub, svc, remove } = world({ [MASTER]: TINY_JPEG });
    await svc.record(ITEM, MASTER, true, { thumbPath: THUMB });
    expect(inserted(stub)).toMatchObject({ storage_path: MASTER, thumb_path: null });
    expect(remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a master never uploaded: refused with a plain sentence, nothing removed, nothing recorded', async () => {
    const { stub, svc, remove } = world({});
    await expect(svc.record(ITEM, MASTER, true)).rejects.toMatchObject({
      message: 'This photo could not be read. Try uploading it again.',
    });
    expect(remove).not.toHaveBeenCalled();
    expect(stub.chains.has('item_images.insert')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('a recorder that fails: still refused, still removed, still no row', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    const { stub, svc, remove } = world({ [MASTER]: HTML_PAGE });
    await expect(svc.record(ITEM, MASTER, true)).rejects.toMatchObject({ code: 'validation_error' });
    expect(remove).toHaveBeenCalledWith([MASTER]);
    expect(stub.chains.has('item_images.insert')).toBe(false);
  });

  it('every read is held to the item photo ceiling', async () => {
    const { svc } = world({ [MASTER]: TINY_JPEG, [THUMB]: TINY_PNG });
    await svc.record(ITEM, MASTER, true, { thumbPath: THUMB });
    expect(fetchObjectWindowMock).toHaveBeenCalledTimes(2);
    for (const call of fetchObjectWindowMock.mock.calls) {
      expect(call[3]).toEqual({ maxTotalBytes: ITEM_IMAGE_MAX_BYTES });
    }
  });

  it('a master over the ceiling is refused from its stated size: never read whole, removed with an audit line, no event', async () => {
    const { stub, svc, remove, whole } = world({ [MASTER]: TINY_JPEG, [THUMB]: TINY_PNG }, 4096, {
      [MASTER]: ITEM_IMAGE_MAX_BYTES + 1,
    });
    await expect(svc.record(ITEM, MASTER, true, { thumbPath: THUMB })).rejects.toMatchObject({
      code: 'validation_error',
      message: UPLOAD_TOO_LARGE_MESSAGE,
    });
    expect(whole).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([MASTER, THUMB]);
    expect(stub.chains.has('item_images.insert')).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(removalLines()).toHaveLength(1);
    expect(removalLines()[0]![0].extra).toEqual({ surface: 'item_photo', why: 'too_large', objects: 2 });
  });

  it('a recorded master named with a junk thumbnail is never removed: refused, nothing removed, no audit line', async () => {
    stillNamedMock.mockResolvedValue(true);
    const { stub, svc, remove } = world({ [MASTER]: TINY_JPEG, [THUMB]: HTML_PAGE });
    await expect(svc.record(ITEM, MASTER, true, { thumbPath: THUMB })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stillNamedMock).toHaveBeenCalledWith('item_images', ['storage_path', 'thumb_path'], [MASTER, THUMB]);
    expect(remove).not.toHaveBeenCalled();
    expect(removalLines()).toHaveLength(0);
    expect(stub.chains.has('item_images.insert')).toBe(false);
  });

  it('a look that fails removes nothing either', async () => {
    stillNamedMock.mockRejectedValue(new Error('look failed'));
    const { svc, remove } = world({ [MASTER]: HTML_PAGE });
    await expect(svc.record(ITEM, MASTER, true)).rejects.toMatchObject({ code: 'validation_error' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('a photo named as its own thumbnail is refused before anything is read', async () => {
    const { stub, svc, remove } = world({ [MASTER]: TINY_JPEG });
    await expect(svc.record(ITEM, MASTER, true, { thumbPath: MASTER })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(fetchObjectWindowMock).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(stub.chains.has('item_images.insert')).toBe(false);
  });

  it('a whole read that fails is "try again": nothing removed, nothing recorded', async () => {
    const { stub, svc, remove } = world({ [MASTER]: TINY_PNG }, 30);
    fetchObjectWholeMock.mockResolvedValue(null);
    await expect(svc.record(ITEM, MASTER, true)).rejects.toMatchObject({
      message: 'This photo could not be read. Try uploading it again.',
    });
    expect(remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(stub.chains.has('item_images.insert')).toBe(false);
  });

  it('a per-person limit, closed, comes before any read', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, failed: true });
    const { stub, svc, remove } = world({ [MASTER]: TINY_JPEG });
    await expect(svc.record(ITEM, MASTER, true)).rejects.toMatchObject({ code: 'conflict' });
    expect(checkRateLimitMock).toHaveBeenCalledWith('item-images:record:user-test', 60, 60_000, 'closed');
    expect(fetchObjectWindowMock).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(stub.chains.has('item_images.insert')).toBe(false);
  });
});
