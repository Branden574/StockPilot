import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): a procedure video and its poster are
// finalized through the one upload check (ProcedureVideosService.record).
// Nothing had read either object. The video's container signature is read
// from its first bytes only (MP4, QuickTime, WebM; never the whole video);
// the poster is checked as a picture (JPEG or WebP) and stays optional. A
// refusal removes BOTH objects, writes no row, answers a plain sentence, and
// records exactly one malware / blocked event in the organization with no
// path. A clean video records its row as before. Tiny made-up files only.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  objects: {} as Record<string, Uint8Array>,
  /** A size storage states other than the bytes' own, for an object too large to build here. */
  sizes: {} as Record<string, number>,
  remove: vi.fn(async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null })),
  stillNamed: vi.fn(async (_t: string, _c: readonly string[], _p: readonly string[]) => false),
  checkRateLimit: vi.fn(async () => ({ allowed: true, failed: false })),
  whole: vi.fn(),
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    throw new Error('outside a request');
  }),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ storage: { from: () => ({ remove: h.remove }) } })),
}));
const served = (_bucket: unknown, path: string, limit?: { maxTotalBytes?: number }) => {
  const body = h.objects[path];
  if (!body) return null;
  const total = h.sizes[path] ?? body.byteLength;
  if (limit?.maxTotalBytes !== undefined && total > limit.maxTotalBytes) {
    return { prefix: new Uint8Array(0), totalSize: total, overLimit: true };
  }
  return { prefix: body.subarray(0, 4096), totalSize: total };
};
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: vi.fn(),
  fetchObjectWindow: vi.fn(async (b: unknown, p: string, _f: unknown, limit?: { maxTotalBytes?: number }) =>
    served(b, p, limit),
  ),
  fetchObjectWhole: h.whole,
}));
vi.mock('./upload-still-named', () => ({ uploadObjectsStillNamed: h.stillNamed }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: h.checkRateLimit }));

import { fetchObjectWindow } from '@/lib/storage-object-prefix';
import { PROCEDURE_POSTER_MAX_BYTES, PROCEDURE_VIDEO_MAX_BYTES } from '@/lib/upload-size-limits';
import { recordSecurityEvent } from '@/server/security/events';
import { UPLOAD_TOO_LARGE_MESSAGE } from '@/server/security/upload-checks';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import {
  expectOneRefusal,
  HTML_PAGE,
  JPEG_WITH_ARCHIVE,
  TINY_JPEG,
  TINY_MP4,
  TINY_PDF,
  TINY_PNG,
  TINY_QUICKTIME,
  TINY_WEBM,
} from '@/test/upload-fixtures';

import { audit } from './audit';
import { ProcedureVideosService } from './procedure-videos';

const record = vi.mocked(recordSecurityEvent);
const ORG = '11111111-1111-4111-8111-111111111111';
const PROC = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const VIDEO = `${ORG}/${PROC}/${FILE}.mp4`;
const POSTER = `${ORG}/${PROC}/${FILE}.poster.jpg`;

function service() {
  const stub = makeSupabaseStub({
    'procedures.select': { data: { id: PROC }, error: null },
    'procedure_videos.select': { data: { order_idx: 0 }, error: null },
    'procedure_videos.insert': { data: { id: 'vid-1', procedure_id: PROC }, error: null },
  });
  const svc = new ProcedureVideosService(
    makeServiceContext(stub.client, { role: 'admin', organizationId: ORG }) as never,
  );
  return { stub, svc };
}
const insertedRow = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.chainArgs.get('procedure_videos.insert')?.[0]?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(h.objects)) delete h.objects[k];
  for (const k of Object.keys(h.sizes)) delete h.sizes[k];
  record.mockImplementation(async () => undefined);
  h.stillNamed.mockResolvedValue(false);
  h.checkRateLimit.mockResolvedValue({ allowed: true, failed: false });
  h.whole.mockImplementation(async (_b: unknown, path: string, size: number) => {
    const body = h.objects[path];
    return body && body.byteLength === size ? body : null;
  });
});

const removalLines = () =>
  vi.mocked(audit).mock.calls.filter(([p]) => p.event === 'security.upload_refused_removed');

describe('procedure video finalize', () => {
  it.each([
    ['an MP4', TINY_MP4, 'video/mp4'],
    ['a QuickTime movie', TINY_QUICKTIME, 'video/quicktime'],
    ['a WebM', TINY_WEBM, 'video/webm'],
  ])('%s with its poster: the row as before (declared type kept), nothing removed or recorded', async (_what, body, mimeType) => {
    h.objects[VIDEO] = body;
    h.objects[POSTER] = TINY_JPEG;
    const { stub, svc } = service();
    await svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER, mimeType } as never);
    expect(insertedRow(stub)).toMatchObject({ storage_path: VIDEO, thumbnail_path: POSTER, mime_type: mimeType });
    expect(h.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a video', HTML_PAGE],
    ['a PDF called a video', TINY_PDF],
    ['a picture called a video', TINY_PNG],
  ])('the video is %s: both removed, no row, a plain sentence, one event', async (_what, body) => {
    h.objects[VIDEO] = body;
    h.objects[POSTER] = TINY_JPEG;
    const { stub, svc } = service();
    await expect(
      svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: 'This file is not an MP4, MOV or WebM video. Pick a real video file.',
    });
    expect(h.remove).toHaveBeenCalledWith([VIDEO, POSTER]);
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
    expectOneRefusal(record, { reason: 'upload_wrong_type', organizationId: ORG }, [VIDEO, FILE]);
  });

  it.each([
    ['a web page called a poster', HTML_PAGE, 'upload_wrong_type'],
    ['a poster with an archive after the picture', JPEG_WITH_ARCHIVE, 'upload_hidden_file'],
  ])('%s: both removed, no row, one event', async (_what, body, reason) => {
    h.objects[VIDEO] = TINY_MP4;
    h.objects[POSTER] = body;
    const { stub, svc } = service();
    await expect(
      svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(h.remove).toHaveBeenCalledWith([VIDEO, POSTER]);
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
    expectOneRefusal(record, { reason, organizationId: ORG }, [POSTER]);
  });

  it('a poster never uploaded is "no poster": the row without it, nothing removed or recorded', async () => {
    h.objects[VIDEO] = TINY_MP4;
    const { stub, svc } = service();
    await svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never);
    expect(insertedRow(stub)).toMatchObject({ storage_path: VIDEO, thumbnail_path: null });
    expect(h.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a video never uploaded: refused, nothing removed, nothing recorded', async () => {
    const { stub, svc } = service();
    await expect(svc.record({ procedureId: PROC, storagePath: VIDEO } as never)).rejects.toMatchObject({
      message: 'This video could not be read. Try uploading it again.',
    });
    expect(h.remove).not.toHaveBeenCalled();
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('a recorder that fails: still refused, still removed, still no row', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    h.objects[VIDEO] = HTML_PAGE;
    const { stub, svc } = service();
    await expect(svc.record({ procedureId: PROC, storagePath: VIDEO } as never)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(h.remove).toHaveBeenCalledWith([VIDEO]);
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
  });

  it('the video is read from its first window only, held to 1 GiB; the poster is held to its own small cap', async () => {
    h.objects[VIDEO] = TINY_MP4;
    h.sizes[VIDEO] = 900 * 1024 * 1024;
    h.objects[POSTER] = TINY_JPEG;
    const { stub, svc } = service();
    await svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never);
    expect(insertedRow(stub)).toMatchObject({ storage_path: VIDEO, thumbnail_path: POSTER });
    const calls = vi.mocked(fetchObjectWindow).mock.calls.map((c) => [c[1], c[3]]);
    expect(calls).toEqual([
      [VIDEO, { maxTotalBytes: PROCEDURE_VIDEO_MAX_BYTES }],
      [POSTER, { maxTotalBytes: PROCEDURE_POSTER_MAX_BYTES }],
    ]);
    // Never the video whole.
    expect(h.whole.mock.calls.map((c) => c[1])).not.toContain(VIDEO);
  });

  it('a "poster" larger than its cap is refused from the size storage states: never read, both removed, no event', async () => {
    h.objects[VIDEO] = TINY_MP4;
    h.objects[POSTER] = TINY_JPEG;
    h.sizes[POSTER] = 1024 * 1024 * 1024;
    const { stub, svc } = service();
    await expect(
      svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never),
    ).rejects.toMatchObject({ code: 'validation_error', message: UPLOAD_TOO_LARGE_MESSAGE });
    expect(h.whole).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalledWith([VIDEO, POSTER]);
    expect(record).not.toHaveBeenCalled();
    expect(removalLines().map(([p]) => p.extra)).toEqual([
      { surface: 'procedure_poster', why: 'too_large', objects: 2 },
    ]);
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
  });

  it('a recorded video named again, with a junk poster, is never removed: refused, no audit line', async () => {
    h.objects[VIDEO] = TINY_MP4;
    h.objects[POSTER] = HTML_PAGE;
    h.stillNamed.mockResolvedValue(true);
    const { stub, svc } = service();
    await expect(
      svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(h.stillNamed).toHaveBeenCalledWith('procedure_videos', ['storage_path', 'thumbnail_path'], [VIDEO, POSTER]);
    expect(h.remove).not.toHaveBeenCalled();
    expect(removalLines()).toHaveLength(0);
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
  });

  it('a video named as its own poster is refused before anything is read or removed', async () => {
    h.objects[VIDEO] = TINY_MP4;
    const { stub, svc } = service();
    await expect(
      svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: VIDEO } as never),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(fetchObjectWindow).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
  });

  it('a poster whose whole read fails is "try again": the video and poster are kept, nothing recorded', async () => {
    h.objects[VIDEO] = TINY_MP4;
    h.objects[POSTER] = TINY_JPEG;
    h.sizes[POSTER] = 50_000;
    const { stub, svc } = service();
    await expect(
      svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never),
    ).rejects.toMatchObject({ message: 'This video could not be read. Try uploading it again.' });
    expect(h.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
  });

  it('a removal leaves one audit line, with no path', async () => {
    h.objects[VIDEO] = HTML_PAGE;
    h.objects[POSTER] = TINY_JPEG;
    const { svc } = service();
    await svc.record({ procedureId: PROC, storagePath: VIDEO, thumbnailPath: POSTER } as never).catch(() => undefined);
    expect(removalLines()).toHaveLength(1);
    expect(removalLines()[0]![0].extra).toEqual({ surface: 'procedure_video', why: 'wrong_type', objects: 2 });
    expect(JSON.stringify(removalLines()[0])).not.toContain(FILE);
  });

  it('a per-person limit, closed, comes before any read', async () => {
    h.checkRateLimit.mockResolvedValue({ allowed: false, failed: true });
    h.objects[VIDEO] = TINY_MP4;
    const { stub, svc } = service();
    await expect(svc.record({ procedureId: PROC, storagePath: VIDEO } as never)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(h.checkRateLimit).toHaveBeenCalledWith('procedure-videos:record:user-test', 30, 60_000, 'closed');
    expect(fetchObjectWindow).not.toHaveBeenCalled();
    expect(stub.chains.has('procedure_videos.insert')).toBe(false);
  });
});
