import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): every upload path's one check. On a
// refusal, exactly ONE security event (malware / blocked / the verdict's
// family), with the caller's organization and no file name, path or byte; a
// clean file records nothing; a recorder that fails changes no answer; a
// stored object that is refused is removed with its thumbnail or poster.
// Fixtures are tiny made-up files built here (the repository is public).
// ---------------------------------------------------------------------------

const { fetchObjectPrefixMock, fetchObjectWindowMock } = vi.hoisted(() => ({
  fetchObjectPrefixMock: vi.fn(),
  fetchObjectWindowMock: vi.fn(),
}));
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectPrefix: fetchObjectPrefixMock,
  fetchObjectWindow: fetchObjectWindowMock,
  SNIFF_PREFIX_BYTES: 4096,
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    throw new Error('outside a request');
  }),
}));

import { THREAT_MESSAGES } from '@/lib/document-threat-scan';
import { recordSecurityEvent } from '@/server/security/events';

import {
  checkStoredUpload,
  checkStoredUploadSignature,
  checkUploadBytes,
  checkUploadPrefix,
  UPLOAD_OFFICE_MACRO_MESSAGE,
  UPLOAD_WRONG_TYPE_MESSAGE,
  type StoredUploadBucket,
} from './upload-checks';

const record = vi.mocked(recordSecurityEvent);
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

  it('the sentence: the path own for the wrong type, the scanner own for a verdict, no detail of the check', async () => {
    expect(await checkUploadBytes(HTML, { ...base, accept: ['png'] })).toMatchObject({
      message: UPLOAD_WRONG_TYPE_MESSAGE,
    });
    expect(
      await checkUploadBytes(HTML, { ...base, accept: ['png'], wrongTypeMessage: 'Pick a real image file.' }),
    ).toMatchObject({ message: 'Pick a real image file.' });
    expect(await checkUploadBytes(PDF_SCRIPT, { ...base, accept: ['pdf'] })).toMatchObject({
      message: THREAT_MESSAGES.pdf_javascript,
    });
    expect(await checkUploadBytes(PNG_WITH_ARCHIVE, { ...base, accept: ['png'] })).toMatchObject({
      message: THREAT_MESSAGES.appended_payload,
    });
    expect(UPLOAD_OFFICE_MACRO_MESSAGE).not.toMatch(/vba|activex|\.bin|macrosheet/i);
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

describe('checkStoredUpload: the finalize of an object a client put in storage', () => {
  function bucket(downloadBody: Uint8Array | null = null) {
    const remove = vi.fn(async () => ({ data: null, error: null }));
    const download = vi.fn(async () =>
      downloadBody
        ? { data: new Blob([downloadBody]), error: null }
        : { data: null, error: { message: 'gone' } },
    );
    const store = { remove, download, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    return { store, remove, download };
  }
  const stored = {
    ...base,
    accept: ['png', 'pdf'] as const,
    removeOnRefusal: [PATH, `${PATH}.thumb`],
    unreadableMessage: 'This file could not be verified.',
  };

  it('a clean small object: no download, no removal, no event, and the bytes it checked', async () => {
    fetchObjectPrefixMock.mockResolvedValue({ prefix: PNG, totalSize: PNG.byteLength });
    const { store, remove, download } = bucket();
    const out = await checkStoredUpload(store, PATH, stored);
    expect(out).toMatchObject({ ok: true, kind: 'png', bytes: PNG });
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a large object is read whole for the scan; a hidden file in it is refused, removed, one event', async () => {
    const big = concat(PNG, new Uint8Array(5000).fill(0x20), Uint8Array.from([0x50, 0x4b, 0x05, 0x06]));
    fetchObjectPrefixMock.mockResolvedValue({ prefix: big.subarray(0, 4096), totalSize: big.byteLength });
    const { store, remove, download } = bucket(big);
    const out = await checkStoredUpload(store, PATH, stored);
    expect(out).toMatchObject({ ok: false, family: 'hidden_file', message: THREAT_MESSAGES.appended_payload });
    expect(download).toHaveBeenCalledWith(PATH);
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(onlyEvent().event.reason).toBe('upload_hidden_file');
  });

  it('a fake is refused from its leading bytes before any whole read: removed, one event', async () => {
    fetchObjectPrefixMock.mockResolvedValue({ prefix: HTML, totalSize: 10_000_000 });
    const { store, remove, download } = bucket();
    const out = await checkStoredUpload(store, PATH, { ...stored, wrongTypeMessage: 'Not a real image.' });
    expect(out).toEqual({ ok: false, family: 'wrong_type', message: 'Not a real image.' });
    expect(download).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(onlyEvent().event.reason).toBe('upload_wrong_type');
  });

  it('an object that cannot be read records nothing and is not removed; one gone between reads is removed', async () => {
    fetchObjectPrefixMock.mockResolvedValue(null);
    const first = bucket();
    expect(await checkStoredUpload(first.store, PATH, stored)).toEqual({
      ok: false,
      family: null,
      message: 'This file could not be verified.',
    });
    expect(first.remove).not.toHaveBeenCalled();
    fetchObjectPrefixMock.mockResolvedValue({ prefix: PDF.subarray(0, 8), totalSize: 9000 });
    const second = bucket(null);
    expect(await checkStoredUpload(second.store, PATH, stored)).toMatchObject({ ok: false, family: null });
    expect(second.remove).toHaveBeenCalledWith([PATH, `${PATH}.thumb`]);
    expect(record).not.toHaveBeenCalled();
  });

  it('a recorder failure still removes and still refuses', async () => {
    record.mockImplementation(async () => {
      throw new Error('recorder down');
    });
    fetchObjectPrefixMock.mockResolvedValue({ prefix: PDF_SCRIPT, totalSize: PDF_SCRIPT.byteLength });
    const { store, remove } = bucket();
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: 'active_content' });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('a removal that throws is swallowed: the refusal stands', async () => {
    fetchObjectPrefixMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    const { store, remove } = bucket();
    remove.mockRejectedValue(new Error('storage down'));
    expect(await checkStoredUpload(store, PATH, stored)).toMatchObject({ ok: false, family: 'wrong_type' });
  });
});

describe('checkStoredUploadSignature: a video, by its container only', () => {
  const input = {
    ...base,
    surface: 'procedure_video' as const,
    accept: ['mp4', 'quicktime', 'webm'] as const,
    removeOnRefusal: [PATH, `${PATH}.poster.jpg`],
    unreadableMessage: 'This video could not be read.',
  };
  it('reads the leading window only, never the whole video', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: MP4, totalSize: 900_000_000 });
    const download = vi.fn();
    const remove = vi.fn();
    const store = { download, remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    expect(await checkStoredUploadSignature(store, PATH, input)).toMatchObject({ ok: true, kind: 'mp4' });
    expect(download).not.toHaveBeenCalled();
    expect(fetchObjectPrefixMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a file that is not a video is refused, the video and its poster removed, one event', async () => {
    fetchObjectWindowMock.mockResolvedValue({ prefix: HTML, totalSize: HTML.byteLength });
    const remove = vi.fn(async () => ({}));
    const store = { download: vi.fn(), remove, createSignedUrl: vi.fn() } as unknown as StoredUploadBucket;
    expect(await checkStoredUploadSignature(store, PATH, input)).toMatchObject({ ok: false, family: 'wrong_type' });
    expect(remove).toHaveBeenCalledWith([PATH, `${PATH}.poster.jpg`]);
    expect(onlyEvent().event.reason).toBe('upload_wrong_type');
  });
});
