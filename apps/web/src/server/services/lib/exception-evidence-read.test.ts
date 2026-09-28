import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('server-only', () => ({}));

const signer = vi.hoisted(() => ({
  calls: [] as Array<{ paths: string[]; ttl: number }>,
  failCall: -1,
  failPaths: new Set<string>(),
}));
const createSignedUrls = vi.hoisted(() =>
  vi.fn(async (paths: string[], ttl: number) => {
    signer.calls.push({ paths, ttl });
    if (signer.calls.length - 1 === signer.failCall)
      return { data: null, error: { message: 'sign failed' } };
    return {
      data: paths.map((path) =>
        signer.failPaths.has(path)
          ? { path, signedUrl: null, error: 'Object not found' }
          : { path, signedUrl: `https://signed/${path}?token=t`, error: null },
      ),
      error: null,
    };
  }),
);
const storageFrom = vi.hoisted(() => vi.fn((_bucket: string) => ({ createSignedUrls })));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ storage: { from: storageFrom } })),
}));

import {
  buildEvidenceBlock,
  evidenceEventInfo,
  EVIDENCE_VIEW_URL_TTL_SEC,
  LIVE_EVIDENCE_READ_BOUND,
  readEvidenceEventInfo,
  readLiveEvidenceRows,
  signEvidencePaths,
  SIGN_PATHS_PER_CALL,
  type EvidenceRow,
} from './exception-evidence-read';

function row(o: Partial<EvidenceRow> & { id: string }): EvidenceRow {
  return {
    uploaded_by: 'u-staff',
    storage_path: `org/occ/${o.id}.jpg`,
    thumbnail_path: `org/occ/${o.id}-thumb.webp`,
    content_type: 'image/jpeg',
    byte_size: 1000,
    captured_at: null,
    note: null,
    created_at: '2026-09-27T12:00:00Z',
    removed_at: null,
    removed_by: null,
    uploader: { full_name: 'Maria Lopez', email: 'maria@x.test' },
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  signer.calls = [];
  signer.failCall = -1;
  signer.failPaths = new Set();
});

describe('signEvidencePaths', () => {
  it('signs from the exception-evidence bucket, for ONE HOUR (literal pin: 3600 s)', async () => {
    await signEvidencePaths(['a.jpg']);
    expect(storageFrom).toHaveBeenCalledWith('exception-evidence');
    expect(EVIDENCE_VIEW_URL_TTL_SEC).toBe(3600);
    expect(signer.calls[0]!.ttl).toBe(3600);
  });

  it('never sends more than 1000 paths in one call (storage refuses the whole call past it)', async () => {
    expect(SIGN_PATHS_PER_CALL).toBe(1000);
    const paths = Array.from({ length: 2500 }, (_, i) => `p${i}.jpg`);
    const out = await signEvidencePaths(paths);
    expect(signer.calls.map((c) => c.paths.length)).toEqual([1000, 1000, 500]);
    expect(out.size).toBe(2500);
    expect(out.get('p2499.jpg')).toBe('https://signed/p2499.jpg?token=t');
  });

  it('a whole call that fails throws (nothing in it was signed)', async () => {
    signer.failCall = 1;
    await expect(
      signEvidencePaths(Array.from({ length: 1500 }, (_, i) => `p${i}.jpg`)),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('a path the storage could not sign maps to null, not to a broken link', async () => {
    signer.failPaths.add('b.jpg');
    const out = await signEvidencePaths(['a.jpg', 'b.jpg']);
    expect(out.get('a.jpg')).toMatch(/^https:/);
    expect(out.get('b.jpg')).toBeNull();
  });

  it('signs nothing for no paths', async () => {
    expect((await signEvidencePaths([])).size).toBe(0);
    expect(createSignedUrls).not.toHaveBeenCalled();
  });
});

describe('buildEvidenceBlock', () => {
  const staff = { userId: 'u-staff', role: 'staff' as const };
  const open = { canAct: true, resolvedAt: null };

  it('only LIVE photos are listed and signed; a removed photo is neither', async () => {
    const block = await buildEvidenceBlock(staff, open, [
      row({ id: 'e1' }),
      row({ id: 'e2', removed_at: '2026-09-27T12:30:00Z', removed_by: 'u-staff' }),
    ]);
    expect(block.status).toBe('ok');
    if (block.status !== 'ok') return;
    expect(block.photos.map((p) => p.id)).toEqual(['e1']);
    expect(block.liveCount).toBe(1);
    expect(signer.calls.flatMap((c) => c.paths)).toEqual([
      'org/occ/e1.jpg',
      'org/occ/e1-thumb.webp',
    ]);
  });

  it('each photo: uploader label, the two times, note, signed links', async () => {
    const block = await buildEvidenceBlock(staff, open, [
      row({
        id: 'e1',
        captured_at: '2026-09-27T11:50:00Z',
        note: 'shelf empty',
        byte_size: '2048',
      }),
    ]);
    if (block.status !== 'ok') throw new Error('unavailable');
    expect(block.photos[0]).toEqual({
      id: 'e1',
      uploadedBy: { id: 'u-staff', label: 'Maria Lopez' },
      capturedAt: '2026-09-27T11:50:00Z',
      uploadedAt: '2026-09-27T12:00:00Z',
      note: 'shelf empty',
      contentType: 'image/jpeg',
      byteSize: 2048,
      url: 'https://signed/org/occ/e1.jpg?token=t',
      thumbUrl: 'https://signed/org/occ/e1-thumb.webp?token=t',
      canRemove: true,
    });
  });

  it('a photo whose link cannot be signed makes the block throw (never a broken image)', async () => {
    signer.failPaths.add('org/occ/e1.jpg');
    await expect(buildEvidenceBlock(staff, open, [row({ id: 'e1' })])).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('a thumbnail that cannot be signed falls back to null (the photo still shows)', async () => {
    signer.failPaths.add('org/occ/e1-thumb.webp');
    const block = await buildEvidenceBlock(staff, open, [row({ id: 'e1' })]);
    if (block.status !== 'ok') throw new Error('unavailable');
    expect(block.photos[0]!.thumbUrl).toBeNull();
    expect(block.photos[0]!.url).toMatch(/^https:/);
  });

  it("Remove: own photo yes, someone else's no, a manager yes, nobody once resolved or without the gate", async () => {
    const rows = [row({ id: 'mine' }), row({ id: 'theirs', uploaded_by: 'u-other' })];
    const asStaff = await buildEvidenceBlock(staff, open, rows);
    const asManager = await buildEvidenceBlock({ userId: 'u-mgr', role: 'manager' }, open, rows);
    const resolved = await buildEvidenceBlock(
      { userId: 'u-mgr', role: 'manager' },
      { canAct: true, resolvedAt: '2026-09-27T13:00:00Z' },
      rows,
    );
    const noGate = await buildEvidenceBlock(staff, { canAct: false, resolvedAt: null }, rows);
    const can = (b: Awaited<ReturnType<typeof buildEvidenceBlock>>) =>
      b.status === 'ok' ? b.photos.map((p) => p.canRemove) : null;
    expect(can(asStaff)).toEqual([true, false]);
    expect(can(asManager)).toEqual([true, true]);
    expect(can(resolved)).toEqual([false, false]);
    expect(can(noGate)).toEqual([false, false]);
  });

  it('Add: open, the gate, and under 8 live photos (removed ones do not count)', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => row({ id: `e${i}` }));
    const withRemoved = [
      ...Array.from({ length: 7 }, (_, i) => row({ id: `e${i}` })),
      row({ id: 'gone', removed_at: '2026-09-27T12:30:00Z' }),
    ];
    const canAdd = async (
      actor: typeof staff,
      occ: typeof open | { canAct: boolean; resolvedAt: string | null },
      rows: EvidenceRow[],
    ) => {
      const b = await buildEvidenceBlock(actor, occ, rows);
      return b.status === 'ok' ? b.canAdd : null;
    };
    expect(await canAdd(staff, open, [])).toBe(true);
    expect(await canAdd(staff, open, eight)).toBe(false);
    expect(await canAdd(staff, open, withRemoved)).toBe(true);
    expect(await canAdd(staff, { canAct: false, resolvedAt: null }, [])).toBe(false);
    expect(await canAdd(staff, { canAct: true, resolvedAt: '2026-09-27T13:00:00Z' }, [])).toBe(
      false,
    );
  });

  it('a deleted uploader reads as a former member', async () => {
    const block = await buildEvidenceBlock(staff, open, [
      row({ id: 'e1', uploaded_by: null, uploader: null }),
    ]);
    if (block.status !== 'ok') throw new Error('unavailable');
    expect(block.photos[0]!.uploadedBy).toEqual({ id: null, label: 'Former member' });
    expect(block.photos[0]!.canRemove).toBe(false);
  });
});

describe('readLiveEvidenceRows / readEvidenceEventInfo / evidenceEventInfo', () => {
  it("reads the occurrence's LIVE rows through the caller's client, org-scoped, oldest first", async () => {
    const stub = makeSupabaseStub({
      'exception_evidence.select': { data: [row({ id: 'e1' })], error: null },
    });
    const ctx = makeServiceContext(stub.client, { organizationId: 'org-1' });
    const rows = await readLiveEvidenceRows(ctx as never, 'occ-1');
    expect(rows.map((r) => r.id)).toEqual(['e1']);
    const args = stub.chainArgs.get('exception_evidence.select')!;
    expect(args).toContainEqual(['organization_id', 'org-1']);
    expect(args).toContainEqual(['occurrence_id', 'occ-1']);
    expect(args).toContainEqual(['removed_at', null]);
    expect(args).toContainEqual(['created_at', { ascending: true }]);
    // One row past the bound is asked for, so "more" is seen.
    expect(args).toContainEqual([0, LIVE_EVIDENCE_READ_BOUND]);
  });

  it('a failed read throws (the caller shows "unavailable", never "no photos")', async () => {
    const stub = makeSupabaseStub({
      'exception_evidence.select': { data: null, error: { message: 'boom' } },
    });
    const ctx = makeServiceContext(stub.client);
    await expect(readLiveEvidenceRows(ctx as never, 'occ-1')).rejects.toBeTruthy();
  });

  it('more live rows than the bound THROWS: never a list cut short and shown as complete', async () => {
    const many = Array.from({ length: LIVE_EVIDENCE_READ_BOUND + 1 }, (_, i) =>
      row({ id: `e${i}` }),
    );
    const stub = makeSupabaseStub({ 'exception_evidence.select': { data: many, error: null } });
    const ctx = makeServiceContext(stub.client);
    await expect(readLiveEvidenceRows(ctx as never, 'occ-1')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('reads the times of exactly the photos named, however many (batched by id), org and occurrence scoped', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `e${i}`);
    const stub = makeSupabaseStub({
      'exception_evidence.select': ((call: { methods: string[]; args: unknown[][] }) => {
        const inArgs = call.args[call.methods.indexOf('in')]!;
        return {
          data: (inArgs[1] as string[]).map((id) => ({
            id,
            captured_at: null,
            created_at: '2026-09-27T12:00:00Z',
            removed_at: id === 'e1499' ? '2026-09-27T13:00:00Z' : null,
          })),
          error: null,
        };
      }) as never,
    });
    const ctx = makeServiceContext(stub.client, { organizationId: 'org-1' });
    const info = await readEvidenceEventInfo(ctx as never, 'occ-1', [...ids, 'e0']);
    expect(info.size).toBe(1500);
    expect(info.get('e1499')).toMatchObject({ removed: true });
    const reads = stub.chainArgsAll.get('exception_evidence.select')!;
    expect(reads.length).toBeGreaterThan(1);
    for (const args of reads) {
      expect(args).toContainEqual(['organization_id', 'org-1']);
      expect(args).toContainEqual(['occurrence_id', 'occ-1']);
    }
  });

  it('no photos named: no read at all; a failed read throws', async () => {
    const quiet = makeSupabaseStub({});
    expect(
      (await readEvidenceEventInfo(makeServiceContext(quiet.client) as never, 'occ-1', [])).size,
    ).toBe(0);
    expect(quiet.fromCalls).toEqual([]);
    const failing = makeSupabaseStub({
      'exception_evidence.select': { data: null, error: { message: 'boom' } },
    });
    await expect(
      readEvidenceEventInfo(makeServiceContext(failing.client) as never, 'occ-1', ['e1']),
    ).rejects.toBeTruthy();
  });

  it("gives the timeline each photo's times, removed ones included", () => {
    const info = evidenceEventInfo([
      row({ id: 'e1', captured_at: '2026-09-27T11:50:00Z' }),
      row({ id: 'e2', removed_at: '2026-09-27T12:30:00Z' }),
    ]);
    expect(info.get('e1')).toEqual({
      capturedAt: '2026-09-27T11:50:00Z',
      uploadedAt: '2026-09-27T12:00:00Z',
      removed: false,
    });
    expect(info.get('e2')).toEqual({
      capturedAt: null,
      uploadedAt: '2026-09-27T12:00:00Z',
      removed: true,
    });
  });
});
