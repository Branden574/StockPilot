import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXCEPTION_EVIDENCE_CAP_COPY,
  EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
  EXCEPTION_EVIDENCE_OFFLINE_COPY,
  EXCEPTION_EVIDENCE_RESOLVED_COPY,
} from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
import {
  describeRemoveEvidenceError,
  EVIDENCE_ADDED_PENDING_COPY,
  EVIDENCE_FINALIZE_TIMEOUT_MS,
  EvidenceResponseError,
  evidenceAddControl,
  evidenceCapCheck,
  evidenceCapturedAt,
  evidenceQueueRowCopy,
  evidenceRetryDisabledReason,
  evidenceRoomLeft,
  evidenceTextState,
  evidenceTick,
  evidenceTimelineLines,
  exifCaptureInstant,
  finalizeEvidence,
  parseEvidenceBlock,
  parseEvidenceEventInfo,
  removeEvidence,
  startEvidenceUpload,
  visibleEvidenceQueue,
  type EvidenceQueueEntry,
  type MobileEvidenceBlock,
} from './exception-evidence';
import { getException } from './exceptions-api';

/**
 * Photo evidence on the phone (F1-4): the pure half. Each block names the
 * wrong code it catches.
 */

const apiMock = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({}) as unknown) }));
vi.mock('./api', () => apiMock);

beforeEach(() => {
  apiMock.api.mockReset();
});

const OCC = '11111111-1111-4111-8111-111111111111';
const EV = '33333333-3333-4333-8333-333333333333';

function photo(o: Record<string, unknown> = {}) {
  return {
    id: EV,
    uploadedBy: { id: 'u-1', label: 'Maria Lopez' },
    capturedAt: '2026-09-27T17:02:00Z',
    uploadedAt: '2026-09-27T17:40:00Z',
    note: 'Shelf 3',
    contentType: 'image/jpeg',
    byteSize: 12345,
    url: 'https://x.supabase.co/storage/v1/object/sign/exception-evidence/o/a/b.jpg?token=t',
    thumbUrl: 'https://x.supabase.co/storage/v1/object/sign/exception-evidence/o/a/b-thumb.webp?token=t',
    canRemove: true,
    ...o,
  };
}

function okBlock(photos: unknown[] = [photo()], o: Record<string, unknown> = {}) {
  return { status: 'ok', photos, liveCount: photos.length, maxPhotos: 8, canAdd: true, ...o };
}

function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { status, details });
}

function entry(o: Partial<EvidenceQueueEntry> = {}): EvidenceQueueEntry {
  return {
    key: 'k1',
    uri: 'file:///p.jpg',
    capturedAt: null,
    note: null,
    status: 'uploading',
    progress: 0,
    retry: null,
    resume: null,
    evidenceId: null,
    doneAt: null,
    ...o,
  };
}

describe('parseEvidenceBlock: a failed read is never "no photos" or fewer photos', () => {
  it('reads a well-formed block', () => {
    const b = parseEvidenceBlock(okBlock());
    expect(b.status).toBe('ok');
    if (b.status !== 'ok') return;
    expect(b.photos).toHaveLength(1);
    expect(b.photos[0]!.uploadedBy.label).toBe('Maria Lopez');
    expect(b.liveCount).toBe(1);
    expect(b.canAdd).toBe(true);
  });

  it('the server\'s unavailable, a missing block and a non-object are all unavailable', () => {
    expect(parseEvidenceBlock({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(parseEvidenceBlock(undefined)).toEqual({ status: 'unavailable' });
    expect(parseEvidenceBlock('ok')).toEqual({ status: 'unavailable' });
    expect(parseEvidenceBlock({ status: 'ok' })).toEqual({ status: 'unavailable' });
  });

  // Mutation caught: skipping the bad photo (the list would show 1 photo of 2).
  it('ONE photo the phone cannot show makes the whole block unavailable', () => {
    expect(parseEvidenceBlock(okBlock([photo(), photo({ id: 'p2', url: null })])).status).toBe('unavailable');
    expect(parseEvidenceBlock(okBlock([photo({ url: 'javascript:alert(1)' })])).status).toBe('unavailable');
    expect(parseEvidenceBlock(okBlock([photo({ uploadedAt: null })])).status).toBe('unavailable');
    expect(parseEvidenceBlock(okBlock([null])).status).toBe('unavailable');
  });

  it('never counts fewer live photos than it lists', () => {
    const b = parseEvidenceBlock(okBlock([photo(), photo({ id: 'p2' })], { liveCount: 1 }));
    expect(b.status === 'ok' && b.liveCount).toBe(2);
  });

  it('offers Remove and Add only on an explicit true from the server', () => {
    const b = parseEvidenceBlock(okBlock([photo({ canRemove: 'yes' })], { canAdd: 1 }));
    expect(b.status === 'ok' && b.photos[0]!.canRemove).toBe(false);
    expect(b.status === 'ok' && b.canAdd).toBe(false);
  });

  it('a thumbnail that is not a link falls back to the photo', () => {
    const b = parseEvidenceBlock(okBlock([photo({ thumbUrl: 'org/a/b-thumb.webp' })]));
    expect(b.status === 'ok' && b.photos[0]!.thumbUrl).toBeNull();
  });

  it('a missing uploader reads "Former member", never blank', () => {
    const b = parseEvidenceBlock(okBlock([photo({ uploadedBy: null })]));
    expect(b.status === 'ok' && b.photos[0]!.uploadedBy).toEqual({ id: null, label: 'Former member' });
  });
});

describe('the detail read carries the photos and the timeline photo times', () => {
  it('getException parses `evidence` and each evidence event\'s times', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      occurrence: {
        id: OCC,
        number: 1,
        reference: 'EX-000001',
        rule: 'label_mismatch',
        itemId: '22222222-2222-4222-8222-222222222222',
        facts: {},
        firstSeenAt: '2026-09-27T15:00:00Z',
        lastSeenAt: '2026-09-27T15:00:00Z',
        canAct: true,
      },
      timeline: [
        { id: 'e1', kind: 'raised', at: '2026-09-27T15:00:00Z', actor: null, note: null, evidence: null },
        {
          id: 'e2',
          kind: 'evidence_added',
          at: '2026-09-27T17:40:00Z',
          actor: { id: 'u-1', label: 'Maria Lopez' },
          note: 'Shelf 3',
          evidence: { capturedAt: '2026-09-27T17:02:00Z', uploadedAt: '2026-09-27T17:40:00Z', removed: false },
        },
        // A non-evidence event never carries photo times, whatever it sends.
        { id: 'e3', kind: 'note', at: '2026-09-27T17:41:00Z', actor: null, note: 'x', evidence: { uploadedAt: 'y' } },
      ],
      history: [],
      historyTruncated: false,
      syncState: null,
      evidence: okBlock(),
    });
    const d = await getException(OCC);
    expect(d.evidence.status).toBe('ok');
    expect(d.timeline[1]!.evidence).toEqual({
      capturedAt: '2026-09-27T17:02:00Z',
      uploadedAt: '2026-09-27T17:40:00Z',
      removed: false,
    });
    expect(d.timeline[0]!.evidence).toBeNull();
    expect(d.timeline[2]!.evidence).toBeNull();
  });

  it('a detail with no evidence block reads photos as unavailable', async () => {
    apiMock.api.mockResolvedValueOnce({
      organizationId: 'org-1',
      occurrence: { id: OCC, rule: 'label_mismatch', itemId: 'i', facts: {} },
      timeline: [],
    });
    const d = await getException(OCC);
    expect(d.evidence).toEqual({ status: 'unavailable' });
  });

  it('parseEvidenceEventInfo needs the upload time', () => {
    expect(parseEvidenceEventInfo({ capturedAt: null })).toBeNull();
    expect(parseEvidenceEventInfo({ uploadedAt: 'x', removed: true })).toEqual({
      capturedAt: null,
      uploadedAt: 'x',
      removed: true,
    });
  });
});

describe('requests', () => {
  it('start: POST the extension, answer the path and the signed PUT link', async () => {
    apiMock.api.mockResolvedValueOnce({ path: 'o/a/u.jpg', signedUrl: 'https://s/put', token: 't', contentType: 'image/jpeg' });
    await expect(startEvidenceUpload(OCC, 'jpg')).resolves.toEqual({ path: 'o/a/u.jpg', signedUrl: 'https://s/put' });
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/exceptions/${OCC}/evidence`, {
      method: 'POST',
      body: { fileExt: 'jpg' },
    });
  });

  it('finalize: POST path, type, the device time and the note, with a longer timeout', async () => {
    apiMock.api.mockResolvedValueOnce({ evidence: { id: EV, capturedAt: null, uploadedAt: 'u' } });
    await expect(
      finalizeEvidence(OCC, { path: 'o/a/u.jpg', declaredMime: 'image/jpeg', capturedAt: 'c', note: 'n' }),
    ).resolves.toEqual({ id: EV, capturedAt: null, uploadedAt: 'u' });
    expect(apiMock.api).toHaveBeenCalledWith(`/api/v1/exceptions/${OCC}/evidence/finalize`, {
      method: 'POST',
      body: { path: 'o/a/u.jpg', declaredMime: 'image/jpeg', capturedAt: 'c', note: 'n' },
      timeoutMs: EVIDENCE_FINALIZE_TIMEOUT_MS,
    });
  });

  it('remove: DELETE with the reason, or no body without one', async () => {
    apiMock.api.mockResolvedValue({ evidence: { id: EV, removedAt: 'r' } });
    await removeEvidence(OCC, EV, 'Wrong shelf');
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/exceptions/${OCC}/evidence/${EV}`, {
      method: 'DELETE',
      body: { reason: 'Wrong shelf' },
    });
    await removeEvidence(OCC, EV, null);
    expect(apiMock.api).toHaveBeenLastCalledWith(`/api/v1/exceptions/${OCC}/evidence/${EV}`, {
      method: 'DELETE',
      body: undefined,
    });
  });

  it('an answer without the fields the phone needs is a failure, never a success', async () => {
    apiMock.api.mockResolvedValueOnce({ path: 'o/a/u.jpg' });
    await expect(startEvidenceUpload(OCC, 'jpg')).rejects.toBeInstanceOf(EvidenceResponseError);
    apiMock.api.mockResolvedValueOnce({});
    await expect(
      finalizeEvidence(OCC, { path: 'p', declaredMime: 'image/jpeg', capturedAt: null, note: null }),
    ).rejects.toBeInstanceOf(EvidenceResponseError);
    apiMock.api.mockResolvedValueOnce({ evidence: { id: EV } });
    await expect(removeEvidence(OCC, EV, null)).rejects.toBeInstanceOf(EvidenceResponseError);
  });

  it('a malformed id is refused without asking the server', async () => {
    await expect(startEvidenceUpload('nope', 'jpg')).rejects.toBeInstanceOf(EvidenceResponseError);
    await expect(removeEvidence(OCC, 'nope', null)).rejects.toBeInstanceOf(EvidenceResponseError);
    expect(apiMock.api).not.toHaveBeenCalled();
  });
});

describe('the capture time (the device\'s clock, never a made-up one)', () => {
  it('reads EXIF DateTimeOriginal with its offset as an instant', () => {
    expect(exifCaptureInstant({ DateTimeOriginal: '2026:09:27 10:02:11', OffsetTimeOriginal: '-07:00' })).toBe(
      '2026-09-27T17:02:11.000Z',
    );
    expect(exifCaptureInstant({ DateTimeOriginal: '2026:09:27 10:02:11', OffsetTimeOriginal: '+0530' })).toBe(
      '2026-09-27T04:32:11.000Z',
    );
  });

  it('a time without its offset names no instant', () => {
    expect(exifCaptureInstant({ DateTimeOriginal: '2026:09:27 10:02:11' })).toBeNull();
    expect(exifCaptureInstant({ DateTimeOriginal: '2026:09:27 10:02:11', OffsetTime: '-07:00' })).toBeNull();
  });

  it('refuses dates that do not exist or cannot be read', () => {
    expect(exifCaptureInstant({ DateTimeOriginal: '2026:02:31 10:00:00', OffsetTimeOriginal: '+00:00' })).toBeNull();
    expect(exifCaptureInstant({ DateTimeOriginal: '2026:13:01 10:00:00', OffsetTimeOriginal: '+00:00' })).toBeNull();
    expect(exifCaptureInstant({ DateTimeOriginal: '0000:00:00 00:00:00', OffsetTimeOriginal: '+00:00' })).toBeNull();
    expect(exifCaptureInstant({ DateTimeOriginal: 'yesterday', OffsetTimeOriginal: '+00:00' })).toBeNull();
    expect(exifCaptureInstant(null)).toBeNull();
  });

  const pickedAt = new Date('2026-09-27T17:40:00Z');

  it('the camera: EXIF first, else the moment the camera handed the photo back', () => {
    expect(evidenceCapturedAt({ source: 'camera', exif: null, pickedAt })).toBe('2026-09-27T17:40:00.000Z');
    expect(
      evidenceCapturedAt({
        source: 'camera',
        exif: { DateTimeOriginal: '2026:09:27 10:39:50', OffsetTimeOriginal: '-07:00' },
        pickedAt,
      }),
    ).toBe('2026-09-27T17:39:50.000Z');
  });

  // Mutation caught: falling back to the pick time for a library photo, which
  // would record "taken just now" for a photo taken last week.
  it('a library photo without usable EXIF has NO capture time', () => {
    expect(evidenceCapturedAt({ source: 'library', exif: null, pickedAt })).toBeNull();
    expect(
      evidenceCapturedAt({ source: 'library', exif: { DateTimeOriginal: '2026:09:20 09:00:00' }, pickedAt }),
    ).toBeNull();
    expect(
      evidenceCapturedAt({
        source: 'library',
        exif: { DateTimeOriginal: '2026:09:20 09:00:00', OffsetTimeOriginal: '-07:00' },
        pickedAt,
      }),
    ).toBe('2026-09-20T16:00:00.000Z');
  });
});

describe('upload rows: no phantom photo, no photo that vanishes', () => {
  const ok = (ids: string[]): MobileEvidenceBlock => ({
    status: 'ok',
    photos: ids.map((id) => ({ ...photo({ id }), uploadedBy: { id: 'u-1', label: 'Maria' } }) as never),
    liveCount: ids.length,
    maxPhotos: 8,
    canAdd: true,
  });

  it('retires a done row once the list shows its photo, and not before', () => {
    const done = entry({ status: 'done', evidenceId: 'p1', doneAt: 5 });
    expect(visibleEvidenceQueue([done], ok([]), 9)).toEqual([done]);
    expect(visibleEvidenceQueue([done], ok(['p1']), 9)).toEqual([]);
  });

  // Mutation caught: retiring an id-less done row on any read (a read that
  // started before the photo was recorded would hide a saved photo).
  it('an id-less done row (already recorded) retires only on a read that STARTED after it', () => {
    const done = entry({ status: 'done', evidenceId: null, doneAt: 5 });
    expect(visibleEvidenceQueue([done], ok([]), 4)).toEqual([done]);
    expect(visibleEvidenceQueue([done], ok([]), 6)).toEqual([]);
  });

  it('uploading and failed rows always stay; an unavailable read retires nothing', () => {
    const rows = [entry({ key: 'a' }), entry({ key: 'b', status: 'error', retry: 'upload' })];
    expect(visibleEvidenceQueue(rows, ok(['p1']), 99)).toEqual(rows);
    const done = entry({ status: 'done', evidenceId: 'p1', doneAt: 1 });
    expect(visibleEvidenceQueue([done], { status: 'unavailable' }, 99)).toEqual([done]);
  });

  it('ticks strictly increase', () => {
    const a = evidenceTick();
    expect(evidenceTick()).toBeGreaterThan(a);
  });

  it('a failed row never reads as added', () => {
    expect(evidenceQueueRowCopy(entry({ status: 'error', retry: 'upload', message: 'X.' }))).toBe('Not added. X.');
    expect(evidenceQueueRowCopy(entry({ status: 'error', retry: 'record', message: 'Y.' }))).toBe(
      'Not confirmed. Y.',
    );
    expect(evidenceQueueRowCopy(entry({ status: 'error', retry: null }))).toBe(`Not added. ${CONNECTION_FAILURE_COPY}`);
    expect(evidenceQueueRowCopy(entry({ status: 'done' }))).toBe(EVIDENCE_ADDED_PENDING_COPY);
    expect(evidenceQueueRowCopy(entry({ status: 'uploading', progress: 0.456 }))).toBe('Uploading 46%');
    expect(evidenceQueueRowCopy(entry({ status: 'uploading', progress: 0 }))).toBe('Uploading');
  });
});

describe('the cap of 8 (photos in flight count)', () => {
  it('counts listed, done and uploading photos; failed rows take no slot', () => {
    const visible = [
      entry({ status: 'done', evidenceId: 'x', doneAt: 1 }),
      entry({ status: 'uploading' }),
      entry({ status: 'error', retry: 'upload' }),
    ];
    expect(evidenceRoomLeft(5, visible)).toBe(1);
    expect(evidenceCapCheck({ liveCount: 5, visible, incoming: 1 })).toEqual({ ok: true });
    expect(evidenceCapCheck({ liveCount: 5, visible, incoming: 2 })).toEqual({
      ok: false,
      message: EXCEPTION_EVIDENCE_CAP_COPY,
    });
    expect(evidenceRoomLeft(8, [])).toBe(0);
    expect(evidenceRoomLeft(9, [])).toBe(0);
  });
});

describe('the add control', () => {
  const block = parseEvidenceBlock(okBlock());
  const base = { block, resolved: false, canAct: true, online: true, visible: [] as EvidenceQueueEntry[] };

  it('online, permitted, under the cap: offered and enabled', () => {
    expect(evidenceAddControl(base)).toEqual({ offered: true, reason: null });
  });

  // Mutation caught: `online: true` (the control stays live offline).
  it('offline: offered but disabled, with core\'s words that nothing is saved for later', () => {
    const c = evidenceAddControl({ ...base, online: false });
    expect(c).toEqual({ offered: true, reason: EXCEPTION_EVIDENCE_OFFLINE_COPY });
    expect(c.reason).toMatch(/not saved offline/);
    expect(evidenceRetryDisabledReason(false)).toBe(EXCEPTION_EVIDENCE_OFFLINE_COPY);
    expect(evidenceRetryDisabledReason(true)).toBeNull();
  });

  it('resolved, or a reader who may not act: not offered, the reason instead', () => {
    expect(evidenceAddControl({ ...base, resolved: true })).toEqual({
      offered: false,
      reason: EXCEPTION_EVIDENCE_RESOLVED_COPY,
    });
    expect(evidenceAddControl({ ...base, canAct: false })).toEqual({
      offered: false,
      reason: EXCEPTION_EVIDENCE_NOT_PERMITTED_COPY,
    });
  });

  it('photos that could not be read: not offered (an unknown count is not room to spare)', () => {
    expect(evidenceAddControl({ ...base, block: { status: 'unavailable' } }).offered).toBe(false);
  });

  it('at the cap, counting photos in flight: disabled with the cap words', () => {
    const seven = parseEvidenceBlock(okBlock(Array.from({ length: 7 }, (_, i) => photo({ id: `p${i}` }))));
    expect(evidenceAddControl({ ...base, block: seven })).toEqual({ offered: true, reason: null });
    expect(evidenceAddControl({ ...base, block: seven, visible: [entry({ status: 'uploading' })] })).toEqual({
      offered: true,
      reason: EXCEPTION_EVIDENCE_CAP_COPY,
    });
  });
});

describe('notes and removal', () => {
  it('a note or reason of up to 500 characters (trimmed) is fine; 501 is too long', () => {
    expect(evidenceTextState(`  ${'a'.repeat(500)}  `)).toEqual({ length: 500, tooLong: false });
    expect(evidenceTextState('a'.repeat(501)).tooLong).toBe(true);
  });

  it('words a failed removal by status and reason, never a bare code', () => {
    expect(describeRemoveEvidenceError(apiError(409, 'x', { reason: 'occurrence_resolved' }))).toBe(
      EXCEPTION_EVIDENCE_RESOLVED_COPY,
    );
    expect(describeRemoveEvidenceError(apiError(403, 'forbidden'))).toBe(
      'Only the person who added a photo, or a manager, can remove it.',
    );
    expect(describeRemoveEvidenceError(apiError(404, 'Photo not found.'))).toMatch(/no longer available/);
    expect(describeRemoveEvidenceError(apiError(400, 'x', { reason: 'reason_too_long' }))).toMatch(/500/);
    expect(describeRemoveEvidenceError(apiError(503, 'internal_error'))).toMatch(/server had a problem/);
    expect(describeRemoveEvidenceError(new TypeError('Network request failed'))).toBe(CONNECTION_FAILURE_COPY);
  });
});

describe('timeline lines (core describeEvidenceEvent)', () => {
  it('an added photo: the headline, both times named by their clocks, and the note', () => {
    const l = evidenceTimelineLines({
      kind: 'evidence_added',
      actorLabel: 'Maria',
      note: 'Shelf 3',
      evidence: { capturedAt: '2026-09-27T17:02:00Z', uploadedAt: '2026-09-27T17:40:00Z', removed: false },
      timeZone: 'America/Los_Angeles',
    });
    expect(l.headline).toBe('Photo added by Maria');
    expect(l.detail).toBe("Taken 10:02 AM (device's clock) · uploaded 10:40 AM (server's clock)");
    expect(l.note).toBe('Shelf 3');
  });

  // Mutation caught: passing nulls through, which prints "The device did not
  // say when it was taken" for a photo whose times simply could not be read.
  it('without the photo\'s info, no times are claimed', () => {
    const l = evidenceTimelineLines({
      kind: 'evidence_added',
      actorLabel: 'Maria',
      note: null,
      evidence: null,
      timeZone: null,
    });
    expect(l.detail).toBeNull();
    expect(l.headline).toBe('Photo added by Maria');
  });

  it('a removal: who, and the reason', () => {
    const l = evidenceTimelineLines({
      kind: 'evidence_removed',
      actorLabel: 'Sam',
      note: 'Wrong shelf',
      evidence: null,
      timeZone: null,
    });
    expect(l).toEqual({ headline: 'Photo removed by Sam', detail: null, note: 'Reason: Wrong shelf' });
  });
});
