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
  remove: vi.fn(async (_paths: string[]) => ({ data: null, error: null })),
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
const served = (_bucket: unknown, path: string) => {
  const body = h.objects[path];
  return body ? { prefix: body, totalSize: body.byteLength } : null;
};
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: vi.fn(async (b: unknown, p: string) => served(b, p)),
  fetchObjectWindow: vi.fn(async (b: unknown, p: string) => served(b, p)),
}));

import { recordSecurityEvent } from '@/server/security/events';
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
  record.mockImplementation(async () => undefined);
});

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
});
