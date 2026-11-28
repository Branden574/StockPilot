import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): every upload path's one check. On a
// refusal, exactly ONE security event (malware / blocked / the verdict's
// family), with the caller's organization and no file name, path or byte; a
// clean file records nothing; a recorder that fails changes no answer; a
// stored object that is refused is removed with its thumbnail or poster.
// Fixtures are tiny made-up files built here (the repository is public).
// ---------------------------------------------------------------------------

const { fetchObjectPrefixMock, fetchObjectWindowMock, fetchObjectWholeMock } = vi.hoisted(() => ({
  fetchObjectPrefixMock: vi.fn(),
  fetchObjectWindowMock: vi.fn(),
  fetchObjectWholeMock: vi.fn(),
}));
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
  fetchObjectWindow: fetchObjectWindowMock,
  fetchObjectWhole: fetchObjectWholeMock,
  SNIFF_PREFIX_BYTES: 4096,
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    throw new Error('outside a request');
  }),
}));

import { STORAGE_STEP_LIMIT_MS, UPLOAD_CHECK_BUDGET_MS } from '@/lib/storage-steps';
import { recordSecurityEvent } from '@/server/security/events';
import { audit } from '@/server/services/audit';

import {
  checkStoredUpload,
  checkStoredUploadSignature,
  checkUploadBytes,
  checkUploadPrefix,
  removeAndAudit,
  removeUnlessNamed,
  UPLOAD_EMPTY_MESSAGE,
  UPLOAD_NOT_CHECKED_MESSAGE,
  UPLOAD_REFUSED_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  UPLOAD_WRONG_TYPE_MESSAGE,
  type StoredUploadBucket,
} from './upload-checks';

/** What lib/storage-object-prefix.ts answers for a storage step past its time limit (lab walk 5). */
const TIMED_OUT = Object.freeze({ timedOut: true as const });

const record = vi.mocked(recordSecurityEvent);
const auditMock = vi.mocked(audit);
const USER = '33333333-3333-4333-8333-333333333333';
const ORG = '11111111-1111-4111-8111-111111111111';
const NAME = 'invoice-of-a-secret-vendor.pdf';
const PATH = `${ORG}/22222222-2222-4222-8222-222222222222/${NAME}`;

const ascii = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
function png(): Uint8Array {
  const ihdr = new Uint8Array(25);
  ihdr.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(ihdr.buffer).setUint32(8, 2);
  new DataView(ihdr.buffer).setUint32(12, 3);
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Uint8Array.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  );
}
const PNG = png();
const PNG_WITH_ARCHIVE = concat(PNG, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
const PDF = ascii('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n');
const PDF_SCRIPT = ascii('%PDF-1.7\n1 0 obj\n<< /S /JavaScript >>\nendobj\n%%EOF\n');
const PDF_LOCKED = ascii('%PDF-1.7\ntrailer << /Encrypt 5 0 R >>\n%%EOF\n');
const HTML = ascii('<!DOCTYPE html><p>not an image</p>');
const MP4 = concat(
  Uint8Array.from([0, 0, 0, 0x18]),
  ascii('ftypisom'),
  Uint8Array.from([0, 0, 2, 0]),
  ascii('isommp41'),
  Uint8Array.from([0, 0, 0, 8]),
  ascii('moov'),
);

const base = { surface: 'po_attachment' as const, organizationId: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  record.mockImplementation(async () => undefined);
});

/** A storage remove that deletes what it is asked to, and lists it, as storage answers. */
function deletes() {
  return vi.fn(async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }));
}

function onlyEvent() {
  expect(record).toHaveBeenCalledTimes(1);
  const [event, headers] = record.mock.calls[0]!;
  expect(Object.keys(event).sort()).toEqual(['category', 'organizationId', 'outcome', 'reason', 'source']);
  // Nothing of the file rides along: not its name, not its path.
  expect(JSON.stringify(event)).not.toContain(NAME);
  expect(JSON.stringify(event)).not.toContain('invoice');
  return { event, headers };
}

describe('checkUploadBytes: one event on a refusal, none on a clean file', () => {
  it('a clean file passes, named by its bytes, and records nothing', async () => {
    expect(await checkUploadBytes(PNG, { ...base, accept: ['png', 'jpeg'] })).toEqual({
      ok: true,
      kind: 'png',
      mime: 'image/png',
      width: 2,
      height: 3,
    });
    expect(await checkUploadBytes(PDF, { ...base, accept: ['pdf'] })).toMatchObject({ ok: true });
    expect(record).not.toHaveBeenCalled();
  });

  it('a file nobody sent (a cover the server fetched) is refused the same way and recorded nowhere (review round 2, Q22)', async () => {
    const out = await checkUploadBytes(HTML, { ...base, accept: ['png'], notRecorded: 'server_fetched_cover' });
    expect(out).toMatchObject({ ok: false, family: 'wrong_type' });
    expect(await checkUploadBytes(PNG_WITH_ARCHIVE, { ...base, accept: ['png'], notRecorded: 'server_fetched_cover' })).toMatchObject({
      ok: false,
      family: 'hidden_file',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['the wrong type', HTML, ['png', 'pdf'], 'upload_wrong_type', 'wrong_type'],
    ['a script inside a PDF', PDF_SCRIPT, ['pdf'], 'upload_active_content', 'active_content'],
    ['an archive after a picture', PNG_WITH_ARCHIVE, ['png'], 'upload_hidden_file', 'hidden_file'],
    ['a locked PDF', PDF_LOCKED, ['pdf'], 'upload_could_not_check', 'could_not_check'],
  ] as const)('%s: refused, one malware event with its reason', async (_what, bytes, accept, reason, family) => {
    const out = await checkUploadBytes(bytes, { ...base, accept });
    expect(out).toMatchObject({ ok: false, family });
    const { event } = onlyEvent();
    expect(event).toEqual({ category: 'malware', outcome: 'blocked', reason, source: 'web', organizationId: ORG });
  });

  it('three sentences: refused by our checks, could not be checked, not a kind this place takes (lab walk 5, F3)', async () => {
    // Not a kind this place takes: the path's own sentence, else the plain one.
    expect(await checkUploadBytes(HTML, { ...base, accept: ['png'] })).toMatchObject({
      message: UPLOAD_WRONG_TYPE_MESSAGE,
    });
    expect(
      await checkUploadBytes(HTML, { ...base, accept: ['png'], wrongTypeMessage: 'Pick a real image file.' }),
    ).toMatchObject({ message: 'Pick a real image file.' });
    // Every refusal by the checks is one sentence, whatever the rule; a
    // path's own wrong-type sentence is never used for one.
    const own = { ...base, wrongTypeMessage: 'Pick a real image file.' };
    for (const [bytes, accept] of [
      [PDF_SCRIPT, ['pdf']],
      [PNG_WITH_ARCHIVE, ['png']],
    ] as const) {
      expect(await checkUploadBytes(bytes, { ...own, accept })).toMatchObject({ message: UPLOAD_REFUSED_MESSAGE });
    }
    // A file the check could not finish.
    expect(await checkUploadBytes(PDF_LOCKED, { ...own, accept: ['pdf'] })).toMatchObject({
      family: 'could_not_check',
      message: UPLOAD_NOT_CHECKED_MESSAGE,
    });
  });

  it('no sentence says what the check looks for, and each says what to do (lab walk 5, F3)', () => {
    const sentences = [UPLOAD_REFUSED_MESSAGE, UPLOAD_NOT_CHECKED_MESSAGE, UPLOAD_WRONG_TYPE_MESSAGE];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(
        /script|media|clip|embedded|inside|hidden|after the end|extra data|macro|control|password|protected|archive|zip|run code|launch|complex/i,
      );
      expect(sentence).toMatch(/\b(Try|Choose|save)\b/);
    }
    expect(new Set(sentences).size).toBe(3);
  });

  it('an empty file is not a refused file: the empty sentence, no verdict, nothing recorded (lab walk 6, W6-F1)', async () => {
    const own = { ...base, wrongTypeMessage: 'Pick a real image file.' };
    for (const accept of [['png'], ['pdf'], ['text'], ['docx'], ['jpeg', 'png', 'webp', 'heic', 'pdf']] as const) {
      expect(await checkUploadBytes(new Uint8Array(0), { ...own, accept })).toEqual({
        ok: false,
        family: null,
        message: UPLOAD_EMPTY_MESSAGE,
      });
    }
    // From the phone too.
    const headers = new Headers({ authorization: 'Bearer abc.def' });
    expect(await checkUploadBytes(new Uint8Array(0), { ...base, accept: ['png'], headers })).toMatchObject({
      message: UPLOAD_EMPTY_MESSAGE,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('the empty-file sentence is the stored paths’ own, beside the three, and says what to do (lab walk 6, W6-F1)', () => {
    expect(UPLOAD_EMPTY_MESSAGE).toBe('This file is empty. Choose the file again and upload it.');
    expect(UPLOAD_EMPTY_MESSAGE).toMatch(/\bChoose\b/);
    expect(new Set([UPLOAD_EMPTY_MESSAGE, UPLOAD_REFUSED_MESSAGE, UPLOAD_NOT_CHECKED_MESSAGE, UPLOAD_WRONG_TYPE_MESSAGE]).size).toBe(4);
  });

  it('no organization is recorded as none; a phone request (bearer) is the phone', async () => {
    await checkUploadBytes(HTML, { ...base, organizationId: null, accept: ['png'] });
    expect(record.mock.calls[0]![0]).toMatchObject({ organizationId: null, source: 'web' });
    record.mockClear();
    const headers = new Headers({ authorization: 'Bearer abc.def' });
    await checkUploadBytes(HTML, { ...base, accept: ['png'], headers });
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'phone' });
    expect(record.mock.calls[0]![1]).toBe(headers);
  });

  it('a recorder that throws or rejects never turns a refusal into an acceptance', async () => {
    record.mockImplementation(() => {
      throw new Error('recorder down');
    });
    expect(await checkUploadBytes(PDF_SCRIPT, { ...base, accept: ['pdf'] })).toMatchObject({
      ok: false,
      family: 'active_content',
    });
    record.mockImplementation(async () => {
      throw new Error('recorder down');
    });
    expect(await checkUploadBytes(HTML, { ...base, accept: ['png'] })).toMatchObject({ ok: false });
  });

  it('a recorder that fails never turns a clean file into a failure (it is not even called)', async () => {
    record.mockImplementation(async () => {
      throw new Error('recorder down');
    });
    expect(await checkUploadBytes(PNG, { ...base, accept: ['png'] })).toMatchObject({ ok: true });
    expect(record).not.toHaveBeenCalled();
  });

  it('the prefix look refuses a fake from its leading bytes, with one event', async () => {
    expect(await checkUploadPrefix(PNG.subarray(0, 30), { ...base, accept: ['png'] })).toMatchObject({ ok: true });
    expect(record).not.toHaveBeenCalled();
    expect(await checkUploadPrefix(HTML, { ...base, accept: ['png'] })).toMatchObject({ family: 'wrong_type' });
    expect(onlyEvent().event.reason).toBe('upload_wrong_type');
  });
});

/** The one audit line of what was done with the objects: who, which path's surface, why, how many; never a path. */
function onlyRemovalLine(
  surface: string,
  why: string,
  objects: number,
  as: { event: string; extra?: Record<string, unknown> } = { event: 'security.upload_refused_removed' },
) {
  expect(auditMock).toHaveBeenCalledTimes(1);
  const [payload, ctx] = auditMock.mock.calls[0]!;
  expect(payload).toEqual({
    event: as.event,
    entityType: 'upload',
    entityId: null,
    extra: { surface, why, objects, ...as.extra },
  });
  expect(ctx).toMatchObject({ organizationId: ORG, userId: USER });
  expect(JSON.stringify(payload)).not.toContain(NAME);
  expect(JSON.stringify(payload)).not.toContain(ORG);
}

describe('checkStoredUpload: the finalize of an object a client put in storage', () => {
  function bucket() {
    const remove = deletes();
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    return { store, remove };
  }
  const MAX = 15 * 1024 * 1024;
  const stillNamed = vi.fn(async () => false);
  const stored = {
    ...base,
    accept: ['png', 'pdf'] as const,
    maxBytes: MAX,
    removeOnRefusal: [PATH, `${PATH}.thumb`],
    stillNamed,
    removedBy: { organizationId: ORG, userId: USER },
    unreadableMessage: 'This file could not be verified.',
  };
  beforeEach(() => {
    stillNamed.mockImplementation(async () => false);
  });

  it('a clean small object: no whole read, no removal, no event, and the bytes it checked', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: PNG, totalSize: PNG.byteLength });
    const { store, remove } = bucket();
    const out = await checkStoredUpload(store, PATH, stored);
    expect(out).toMatchObject({ ok: true, kind: 'png', bytes: PNG });
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('the window read is always given the path ceiling', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: PNG, totalSize: PNG.byteLength });
    await checkStoredUpload(bucket().store, PATH, { ...stored, maxBytes: 5 * 1024 * 1024 });
    expect(fetchObjectWindowMock).toHaveBeenCalledWith(expect.anything(), PATH, expect.any(Function), {
      maxTotalBytes: 5 * 1024 * 1024,
    });
  });

  it('a large object is read whole, exactly its stated size; a hidden file in it is refused, removed, one event, one audit line', async () => {
    const big = concat(PNG, new Uint8Array(5000).fill(0x20), Uint8Array.from([0x50, 0x4b, 0x05, 0x06]));
    fetchObjectWindowMock.mockResolvedValue({ prefix: big.subarray(0, 4096), totalSize: big.byteLength });
    fetchObjectWholeMock.mockResolvedValue(big);
    const { store, remove } = bucket();
    const out = await checkStoredUpload(store, PATH, stored);
    expect(out).toMatchObject({ ok: false, family: 'hidden_file', message: UPLOAD_REFUSED_MESSAGE });
    expect(fetchObjectWholeMock).toHaveBeenCalledWith(store, PATH, big.byteLength);
    expect(stillNamed).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(onlyEvent().event.reason).toBe('upload_hidden_file');
    onlyRemovalLine('po_attachment', 'hidden_file', 2);
  });

  it('an object over the ceiling is refused from the size storage states: never read, removed, an audit line, no event', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: new Uint8Array(0), totalSize: MAX + 1, overLimit: true });
    const { store, remove } = bucket();
    const out = await checkStoredUpload(store, PATH, stored);
    expect(out).toEqual({ ok: false, family: null, message: UPLOAD_TOO_LARGE_MESSAGE });
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(record).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'too_large', 2);
    // The path's own sentence when it has one.
    const own = await checkStoredUpload(bucket().store, PATH, { ...stored, tooLargeMessage: 'Too big.' });
    expect(own).toMatchObject({ ok: false, message: 'Too big.' });
  });

  it('a fake is refused from its leading bytes before any whole read: removed, one event', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: 10_000_000 });
    const { store, remove } = bucket();
    const out = await checkStoredUpload(store, PATH, { ...stored, wrongTypeMessage: 'Not a real image.' });
    expect(out).toEqual({ ok: false, family: 'wrong_type', message: 'Not a real image.' });
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(onlyEvent().event.reason).toBe('upload_wrong_type');
  });

  it('a window an image sniff cannot decide is judged on the whole object, not refused from the window', async () => {
    // A JPEG whose frame header sits past the window: start of image, then a long metadata segment.
    const app1 = new Uint8Array(6002);
    app1.set([0xff, 0xe1, 0x17, 0x70]);
    const sof = Uint8Array.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
    const jpeg = concat(Uint8Array.from([0xff, 0xd8]), app1, sof, Uint8Array.from([0xff, 0xd9]));
    fetchObjectWindowMock.mockResolvedValue({ prefix: jpeg.subarray(0, 4096), totalSize: jpeg.byteLength });
    fetchObjectWholeMock.mockResolvedValue(jpeg);
    const { store, remove } = bucket();
    const out = await checkStoredUpload(store, PATH, { ...stored, accept: ['jpeg'] });
    expect(fetchObjectWholeMock).toHaveBeenCalledWith(store, PATH, jpeg.byteLength);
    expect(out).toMatchObject({ ok: true, kind: 'jpeg' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('an object that cannot be read records nothing and is not removed; nor one that fails its second read', async () => {
    fetchObjectWindowMock.mockResolvedValue(null);
    const first = bucket();
    expect(await checkStoredUpload(first.store, PATH, stored)).toEqual({
      ok: false,
      family: null,
      message: 'This file could not be verified.',
      absent: true,
    });
    expect(first.remove).not.toHaveBeenCalled();
    fetchObjectWindowMock.mockResolvedValue({ prefix: PDF.subarray(0, 8), totalSize: 9000 });
    fetchObjectWholeMock.mockResolvedValue(null);
    const second = bucket();
    const gone = await checkStoredUpload(second.store, PATH, stored);
    expect(gone).toEqual({ ok: false, family: null, message: 'This file could not be verified.' });
    // Readable a moment ago: nothing was judged, so nothing is removed or recorded.
    expect(second.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    // A whole read of another length is the same: judged on nothing.
    fetchObjectWholeMock.mockResolvedValue(new Uint8Array(8999));
    const third = bucket();
    expect(await checkStoredUpload(third.store, PATH, stored)).toMatchObject({ ok: false, family: null });
    expect(third.remove).not.toHaveBeenCalled();
  });

  it('storage that does not answer in time: "could not be checked", nothing judged, removed or recorded (lab walk 5, F2)', async () => {
    fetchObjectWindowMock.mockResolvedValue(TIMED_OUT);
    const first = bucket();
    expect(await checkStoredUpload(first.store, PATH, stored)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_NOT_CHECKED_MESSAGE,
    });
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    // The whole read past its limit is the same answer.
    fetchObjectWindowMock.mockResolvedValue({ prefix: PDF.subarray(0, 8), totalSize: 9000 });
    fetchObjectWholeMock.mockResolvedValue(TIMED_OUT);
    const second = bucket();
    expect(await checkStoredUpload(second.store, PATH, stored)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_NOT_CHECKED_MESSAGE,
    });
    for (const b of [first, second]) expect(b.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('an empty object is refused from its size at once: no further read, removed, an audit line, no event (lab walk 5, F1)', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: new Uint8Array(0), totalSize: 0 });
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_EMPTY_MESSAGE,
    });
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(record).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'empty', 2);
  });

  it('nothing a record still names is ever removed: the refusal stands, a "kept" line, and the event says the file is still in use (review round 2, F1)', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    stillNamed.mockResolvedValue(true);
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: 'wrong_type' });
    expect(stillNamed).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'still_named' },
    });
    expect(onlyEvent().event).toMatchObject({
      category: 'malware',
      outcome: 'flagged',
      reason: 'upload_refused_in_use',
      organizationId: ORG,
    });
  });

  it('a look that fails keeps the objects too, with a "kept" line; the look comes before any removal', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: new Uint8Array(0), totalSize: MAX * 2, overLimit: true });
    stillNamed.mockRejectedValue(new Error('look failed'));
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: null });
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'too_large', 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'look_failed' },
    });
  });

  it('a verdict whose look fails keeps the objects and records the ordinary event (not "in use": nobody knows)', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    stillNamed.mockRejectedValue(new Error('look failed'));
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: 'wrong_type' });
    expect(remove).not.toHaveBeenCalled();
    expect(onlyEvent().event).toMatchObject({ outcome: 'blocked', reason: 'upload_wrong_type' });
  });

  it('the line says "removed" only when storage lists what it deleted (review round 2, F4)', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    // Storage answers an error in the value: the line names its code, never its message.
    const refused = bucket();
    refused.remove.mockResolvedValue({ data: null, error: { name: 'StorageApiError', statusCode: '403', status: 403, message: `denied ${PATH}` } } as never);
    await checkStoredUpload(refused.store, PATH, stored);
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_removal_failed',
      extra: { code: '403' },
    });
    expect(JSON.stringify(auditMock.mock.calls)).not.toContain('denied');
    // A rule that matches no object deletes nothing and answers an empty list.
    auditMock.mockClear();
    record.mockClear();
    const none = bucket();
    none.remove.mockResolvedValue({ data: [], error: null } as never);
    await checkStoredUpload(none.store, PATH, stored);
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_removal_failed',
      extra: { code: 'nothing_removed' },
    });
    // A removal that throws.
    auditMock.mockClear();
    record.mockClear();
    const threw = bucket();
    threw.remove.mockRejectedValue(new Error(`no route to ${PATH}`));
    await checkStoredUpload(threw.store, PATH, stored);
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_removal_failed',
      extra: { code: 'Error' },
    });
    // Storage lists one of the two (the thumbnail was never uploaded): removed, one object.
    auditMock.mockClear();
    record.mockClear();
    const one = bucket();
    one.remove.mockResolvedValue({ data: [{ name: 'x' }], error: null } as never);
    await checkStoredUpload(one.store, PATH, stored);
    onlyRemovalLine('po_attachment', 'wrong_type', 1);
  });

  it('a path named twice is removed once, as one object', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    const { store, remove } = bucket();
    await checkStoredUpload(store, PATH, { ...stored, removeOnRefusal: [PATH, PATH] });
    expect(remove).toHaveBeenCalledWith([PATH]);
    onlyRemovalLine('po_attachment', 'wrong_type', 1);
  });

  it('a recorder failure still removes and still refuses', async () => {
    record.mockImplementation(async () => {
      throw new Error('recorder down');
    });
    fetchObjectWindowMock.mockResolvedValue({ prefix: PDF_SCRIPT, totalSize: PDF_SCRIPT.byteLength });
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: 'active_content' });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('a removal that throws is swallowed: the refusal stands', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    const { store, remove } = bucket();
    remove.mockRejectedValue(new Error('storage down'));
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: 'wrong_type' });
  });

  it('an empty object a record still names is kept: a "kept" line, nothing removed, no event (review round 3)', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: new Uint8Array(0), totalSize: 0 });
    stillNamed.mockResolvedValue(true);
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_EMPTY_MESSAGE,
    });
    expect(stillNamed).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(remove).not.toHaveBeenCalled();
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'empty', 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'still_named' },
    });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('checkStoredUploadSignature: a video, by its container only', () => {
  const stillNamed = vi.fn(async () => false);
  const input = {
    ...base,
    surface: 'procedure_video' as const,
    accept: ['mp4', 'quicktime', 'webm'] as const,
    maxBytes: 1024 * 1024 * 1024,
    removeOnRefusal: [PATH, `${PATH}.poster.jpg`],
    stillNamed,
    removedBy: { organizationId: ORG, userId: USER },
    unreadableMessage: 'This video could not be read.',
  };
  beforeEach(() => {
    stillNamed.mockImplementation(async () => false);
  });
  it('reads the leading window only, with the ceiling, never the whole video', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: MP4, totalSize: 900_000_000 });
    const remove = deletes();
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    expect(await checkStoredUploadSignature(store, PATH, input)).toMatchObject({ ok: true, kind: 'mp4' });
    expect(fetchObjectWindowMock).toHaveBeenCalledWith(store, PATH, expect.any(Function), {
      maxTotalBytes: 1024 * 1024 * 1024,
    });
    expect(fetchObjectWholeMock).not.toHaveBeenCalled();
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a video storage does not read in time is "could not be checked"; an empty one is refused at once (lab walk 5)', async () => {
    const remove = deletes();
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    fetchObjectWindowMock.mockResolvedValue(TIMED_OUT);
    expect(await checkStoredUploadSignature(store, PATH, input)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_NOT_CHECKED_MESSAGE,
    });
    expect(remove).not.toHaveBeenCalled();
    fetchObjectWindowMock.mockResolvedValue({ prefix: new Uint8Array(0), totalSize: 0 });
    expect(await checkStoredUploadSignature(store, PATH, input)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_EMPTY_MESSAGE,
    });
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.poster.jpg`]);
    expect(record).not.toHaveBeenCalled();
  });

  it('a video over the ceiling is refused from its stated size and removed, with an audit line', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: new Uint8Array(0), totalSize: 2 ** 31, overLimit: true });
    const remove = deletes();
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    expect(await checkStoredUploadSignature(store, PATH, input)).toEqual({
      ok: false,
      family: null,
      message: UPLOAD_TOO_LARGE_MESSAGE,
    });
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.poster.jpg`]);
    expect(record).not.toHaveBeenCalled();
    onlyRemovalLine('procedure_video', 'too_large', 2);
  });

  it('a file that is not a video is refused, the video and its poster removed, one event, one audit line', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    const remove = deletes();
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    expect(await checkStoredUploadSignature(store, PATH, input)).toMatchObject({ ok: false, family: 'wrong_type' });
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.poster.jpg`]);
    expect(onlyEvent().event.reason).toBe('upload_wrong_type');
    onlyRemovalLine('procedure_video', 'wrong_type', 2);
  });

  it('a video a record still names is never removed: a "kept" line, and the event says it is in use', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    stillNamed.mockResolvedValue(true);
    const remove = deletes();
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    expect(await checkStoredUploadSignature(store, PATH, input)).toMatchObject({ ok: false });
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('procedure_video', 'wrong_type', 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'still_named' },
    });
    expect(onlyEvent().event).toMatchObject({ outcome: 'flagged', reason: 'upload_refused_in_use' });
  });
});

// ─────────── review round 3: every step answers in time, and one deadline per finalize ───────────

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
/** Answers `value` after `ms` of (fake) time. */
const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/**
 * Starts `start` on a fake clock and says whether it had answered 1 ms
 * before `ms`, and at `ms`. A call that never answers is left waiting: the
 * test fails on `at`, it does not hang.
 */
async function onFakeClock<T>(ms: number, start: () => Promise<T>) {
  vi.useFakeTimers();
  try {
    let answered = false;
    let value: T | undefined;
    const settled = start().then((v) => {
      answered = true;
      value = v;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    const before = answered;
    await vi.advanceTimersByTimeAsync(1);
    const at = answered;
    // What the check still writes after its answer (an audit line, an event) lands now.
    await vi.advanceTimersByTimeAsync(0);
    if (at) await settled;
    return { before, at, value };
  } finally {
    vi.useRealTimers();
  }
}

describe('every step answers in time, and one deadline holds a whole finalize (review round 3)', () => {
  const MAX = 15 * 1024 * 1024;
  const stillNamed = vi.fn(async (_paths: readonly string[]) => false);
  const stored = {
    ...base,
    accept: ['png', 'pdf'] as const,
    maxBytes: MAX,
    removeOnRefusal: [PATH, `${PATH}.thumb`],
    stillNamed,
    removedBy: { organizationId: ORG, userId: USER },
    unreadableMessage: 'This file could not be verified.',
  };
  function bucket(remove: ReturnType<typeof vi.fn> = deletes()) {
    const store = { remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    return { store, remove };
  }
  beforeEach(() => {
    stillNamed.mockImplementation(async () => false);
  });

  it('a look for a record that never answers: at the step limit, kept, nothing removed, "could not be checked"', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    stillNamed.mockImplementation(() => never());
    const { store, remove } = bucket();
    const out = await onFakeClock(STORAGE_STEP_LIMIT_MS, () => checkStoredUpload(store, PATH, stored));
    expect(out).toMatchObject({ before: false, at: true });
    expect(out.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'look_failed' },
    });
    // The file was judged: its one event, as for a look that fails (not "in use": nobody knows).
    expect(onlyEvent().event).toMatchObject({ outcome: 'blocked', reason: 'upload_wrong_type' });
  });

  it.each([
    ['an empty object', { prefix: new Uint8Array(0), totalSize: 0 }, 'empty'],
    ['an object over the ceiling', { prefix: new Uint8Array(0), totalSize: MAX + 1, overLimit: true }, 'too_large'],
  ] as const)('%s whose look never answers: kept, "could not be checked", no event', async (_what, head, why) => {
    fetchObjectWindowMock.mockResolvedValue(head);
    stillNamed.mockImplementation(() => never());
    const { store, remove } = bucket();
    const out = await onFakeClock(STORAGE_STEP_LIMIT_MS, () => checkStoredUpload(store, PATH, stored));
    expect(out).toMatchObject({ before: false, at: true });
    expect(out.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', why, 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'look_failed' },
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('a removal that never answers: at the step limit, the line says the removal failed; the refusal stands', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    const { store, remove } = bucket(vi.fn(() => never()));
    const out = await onFakeClock(STORAGE_STEP_LIMIT_MS, () => checkStoredUpload(store, PATH, stored));
    expect(out).toMatchObject({ before: false, at: true });
    expect(out.value).toEqual({ ok: false, family: 'wrong_type', message: UPLOAD_WRONG_TYPE_MESSAGE });
    expect(remove).toHaveBeenCalledTimes(1);
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_removal_failed',
      extra: { code: 'timed_out' },
    });
    expect(onlyEvent().event.reason).toBe('upload_wrong_type');
  });

  it("each removal outside a finalize check has the step limit too (maintenance, exception evidence, PO import, the logo's pixel limit)", async () => {
    const by = { organizationId: ORG, userId: USER };
    const removal = await onFakeClock(STORAGE_STEP_LIMIT_MS, () =>
      removeAndAudit({ remove: vi.fn(() => never()) }, [PATH], 'maintenance_photo', 'path_refusal', by),
    );
    expect(removal).toMatchObject({ before: false, at: true });
    expect(removal.value).toEqual({ done: 'removal_failed', objects: 1, code: 'timed_out' });
    onlyRemovalLine('maintenance_photo', 'path_refusal', 1, {
      event: 'security.upload_refused_removal_failed',
      extra: { code: 'timed_out' },
    });
    auditMock.mockClear();
    const remove = deletes();
    const look = await onFakeClock(STORAGE_STEP_LIMIT_MS, () =>
      removeUnlessNamed({ remove }, [PATH], () => never(), 'org_logo', 'too_large', by),
    );
    expect(look).toMatchObject({ before: false, at: true });
    expect(look.value).toMatchObject({ done: 'kept', objects: 1, because: 'look_failed' });
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('org_logo', 'too_large', 1, {
      event: 'security.upload_refused_kept',
      extra: { because: 'look_failed' },
    });
  });

  it('the budget is spent: a storage that never answers is "could not be checked" at 45 s, nothing removed or recorded', async () => {
    fetchObjectWindowMock.mockImplementation(() => never());
    const { store, remove } = bucket();
    const out = await onFakeClock(UPLOAD_CHECK_BUDGET_MS, () => checkStoredUpload(store, PATH, stored));
    expect(out).toMatchObject({ before: false, at: true });
    expect(out.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    // The whole read waits the same way.
    fetchObjectWindowMock.mockResolvedValue({ prefix: PDF.subarray(0, 8), totalSize: 9000 });
    fetchObjectWholeMock.mockImplementation(() => never());
    const whole = await onFakeClock(UPLOAD_CHECK_BUDGET_MS, () => checkStoredUpload(store, PATH, stored));
    expect(whole).toMatchObject({ before: false, at: true });
    expect(whole.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    expect(remove).not.toHaveBeenCalled();
    expect(stillNamed).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('one deadline for all the steps: reads that each answer inside their own limits leave the look only what is left, and the finalize ends at 45 s', async () => {
    // Size, signed link and window each a moment under their 8 s; then a
    // signed link and a whole read that leave 2 s of the budget. A file
    // hidden after the picture is refused; the look would answer at 8 s.
    const big = concat(PNG, new Uint8Array(5000).fill(0x20), Uint8Array.from([0x50, 0x4b, 0x05, 0x06]));
    const reads = 3 * (STORAGE_STEP_LIMIT_MS - 1);
    fetchObjectWindowMock.mockImplementation(() =>
      after(reads, { prefix: big.subarray(0, 4096), totalSize: big.byteLength }),
    );
    fetchObjectWholeMock.mockImplementation(() => after(UPLOAD_CHECK_BUDGET_MS - 2_000 - reads, big));
    stillNamed.mockImplementation(() => after(STORAGE_STEP_LIMIT_MS - 1, false));
    const { store, remove } = bucket();
    const out = await onFakeClock(UPLOAD_CHECK_BUDGET_MS, () => checkStoredUpload(store, PATH, stored));
    expect(out).toMatchObject({ before: false, at: true });
    expect(out.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    expect(remove).not.toHaveBeenCalled();
    onlyRemovalLine('po_attachment', 'hidden_file', 2, {
      event: 'security.upload_refused_kept',
      extra: { because: 'look_failed' },
    });
    expect(onlyEvent().event.reason).toBe('upload_hidden_file');
  });

  it('a removal that starts with too little of the budget left is cut at the deadline: the line says it failed', async () => {
    fetchObjectWindowMock.mockImplementation(() =>
      after(UPLOAD_CHECK_BUDGET_MS - 1_000, { prefix: HTML, totalSize: HTML.byteLength }),
    );
    const { store, remove } = bucket(vi.fn(() => never()));
    const out = await onFakeClock(UPLOAD_CHECK_BUDGET_MS, () => checkStoredUpload(store, PATH, stored));
    expect(out).toMatchObject({ before: false, at: true });
    // The budget is spent: the answer is "could not be checked".
    expect(out.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    expect(remove).toHaveBeenCalledTimes(1);
    onlyRemovalLine('po_attachment', 'wrong_type', 2, {
      event: 'security.upload_refused_removal_failed',
      extra: { code: 'timed_out' },
    });
  });

  it('a video check has the same one deadline', async () => {
    fetchObjectWindowMock.mockImplementation(() => never());
    const { store, remove } = bucket();
    const video = {
      ...stored,
      surface: 'procedure_video' as const,
      accept: ['mp4', 'quicktime', 'webm'] as const,
      maxBytes: 1024 * 1024 * 1024,
    };
    const out = await onFakeClock(UPLOAD_CHECK_BUDGET_MS, () => checkStoredUploadSignature(store, PATH, video));
    expect(out).toMatchObject({ before: false, at: true });
    expect(out.value).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
    expect(remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('each finalize has its own budget: the next one starts with all 45 s', async () => {
    fetchObjectWindowMock.mockImplementationOnce(() =>
      after(UPLOAD_CHECK_BUDGET_MS - 1, { prefix: PNG, totalSize: PNG.byteLength }),
    );
    fetchObjectWindowMock.mockImplementationOnce(() => never());
    const { store } = bucket();
    const both = await onFakeClock(2 * UPLOAD_CHECK_BUDGET_MS - 1, async () => [
      await checkStoredUpload(store, PATH, stored),
      await checkStoredUpload(store, `${PATH}.thumb`, stored),
    ]);
    expect(both).toMatchObject({ before: false, at: true });
    expect(both.value).toEqual([
      expect.objectContaining({ ok: true, kind: 'png' }),
      { ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE },
    ]);
  });
});
