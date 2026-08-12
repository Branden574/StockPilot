import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMultipartBody,
  createMultipartBoundary,
  postMultipart,
  type FileByteReader,
} from './multipart-upload';

// 'expo-file-system' is mocked only so importing the module under test doesn't
// pull a native module into the node test environment. Nothing here exercises
// the real reader — every test injects `readBytes`, which is the seam that
// makes the WIRE FORMAT (the thing the server actually parses) assertable.
vi.mock('expo-file-system', () => ({
  File: class {
    async bytes() {
      throw new Error('the real reader must never run under test');
    }
  },
}));

/** A byte-for-byte view of the body as a latin1 string, so a test can pin the
 *  exact framing (CRLFs included) instead of a parsed approximation. */
function asBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

const B = '----TestBoundary';

/** Reader that returns `text` as ASCII bytes for any uri, recording calls. */
function textReader(byUri: Record<string, string>): FileByteReader & { calls: string[] } {
  const calls: string[] = [];
  const reader = (async (uri: string) => {
    calls.push(uri);
    const text = byUri[uri];
    if (text === undefined) throw new Error(`unexpected uri ${uri}`);
    return new TextEncoder().encode(text);
  }) as FileByteReader & { calls: string[] };
  reader.calls = calls;
  return reader;
}

describe('buildMultipartBody', () => {
  it('serializes one file part byte-for-byte (cycle-count ai-scan shape)', async () => {
    const { body, contentType } = await buildMultipartBody({
      files: [
        {
          field: 'image',
          uri: 'file:///cache/scan.jpg',
          fileName: 'scan.jpg',
          contentType: 'image/jpeg',
        },
      ],
      boundary: B,
      readBytes: textReader({ 'file:///cache/scan.jpg': 'JPEGBYTES' }),
    });

    // Literal pin. `/api/cycle-counts/[id]/ai-scan` does
    // `form.get('image') instanceof Blob` and then reads `.type` — which only
    // holds when the part carries BOTH a filename (undici mints a File only
    // then) and its own Content-Type header.
    expect(asBinaryString(body)).toBe(
      `--${B}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="scan.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `\r\n` +
        `JPEGBYTES\r\n` +
        `--${B}--\r\n`,
    );
    expect(contentType).toBe(`multipart/form-data; boundary=${B}`);
  });

  it('repeats the file field once per frame, in order, then the text field (scan-po shape)', async () => {
    const read = textReader({
      'file:///a.jpg': 'AAA',
      'file:///b.jpg': 'BBB',
      'file:///c.png': 'CCC',
    });
    const { body } = await buildMultipartBody({
      files: [
        { field: 'file', uri: 'file:///a.jpg', fileName: 'po-frame-1.jpg', contentType: 'image/jpeg' },
        { field: 'file', uri: 'file:///b.jpg', fileName: 'po-frame-2.jpg', contentType: 'image/jpeg' },
        { field: 'file', uri: 'file:///c.png', fileName: 'po-frame-3.png', contentType: 'image/png' },
      ],
      fields: [{ name: 'mode', value: 'separate' }],
      boundary: B,
      readBytes: read,
    });
    const wire = asBinaryString(body);

    // /api/po-imports/scan does form.getAll('file') and treats the order as
    // page order, so BOTH the repetition count and the sequence are contract.
    expect(wire.match(/name="file"/g)).toHaveLength(3);
    expect(wire.indexOf('po-frame-1.jpg')).toBeLessThan(wire.indexOf('po-frame-2.jpg'));
    expect(wire.indexOf('po-frame-2.jpg')).toBeLessThan(wire.indexOf('po-frame-3.png'));
    expect(read.calls).toEqual(['file:///a.jpg', 'file:///b.jpg', 'file:///c.png']);
    // Per-frame content types must be independent: frame 3 is a PNG.
    expect(wire).toContain(
      `Content-Disposition: form-data; name="file"; filename="po-frame-3.png"\r\nContent-Type: image/png\r\n\r\nCCC\r\n`,
    );
    // The mode field is a plain text part — no filename, no Content-Type,
    // which is what makes `form.get('mode') === 'separate'` a string compare.
    expect(wire).toContain(
      `--${B}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nseparate\r\n--${B}--\r\n`,
    );
    expect(wire.endsWith(`--${B}--\r\n`)).toBe(true);
  });

  it('sends sizeLabel and the optional isNegative flag (size-count training shape)', async () => {
    const { body } = await buildMultipartBody({
      files: [
        {
          field: 'image',
          uri: 'file:///sample.jpg',
          fileName: 'sample.jpg',
          contentType: 'image/jpeg',
        },
      ],
      fields: [
        { name: 'sizeLabel', value: 'NONE' },
        { name: 'isNegative', value: 'true' },
      ],
      boundary: B,
      readBytes: textReader({ 'file:///sample.jpg': 'S' }),
    });

    expect(asBinaryString(body)).toBe(
      `--${B}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="sample.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\nS\r\n` +
        `--${B}\r\nContent-Disposition: form-data; name="sizeLabel"\r\n\r\nNONE\r\n` +
        `--${B}\r\nContent-Disposition: form-data; name="isNegative"\r\n\r\ntrue\r\n` +
        `--${B}--\r\n`,
    );
  });

  it('names the part "file" with an extension matching the MIME (extract-isbns-ai shape)', async () => {
    const { body } = await buildMultipartBody({
      files: [
        {
          field: 'file',
          uri: 'file:///booklist.png',
          fileName: 'booklist.png',
          contentType: 'image/png',
        },
      ],
      boundary: B,
      readBytes: textReader({ 'file:///booklist.png': 'P' }),
    });

    // detectFileKind(file.name, file.type) runs on BOTH, so the pair has to
    // agree or the route 400s with "Unsupported file type".
    expect(asBinaryString(body)).toContain(
      `Content-Disposition: form-data; name="file"; filename="booklist.png"\r\nContent-Type: image/png\r\n`,
    );
  });

  it('never emits the React Native uri-only part shape', async () => {
    const { body } = await buildMultipartBody({
      files: [
        {
          field: 'image',
          uri: 'file:///cache/scan.jpg',
          fileName: 'scan.jpg',
          contentType: 'image/jpeg',
        },
      ],
      boundary: B,
      readBytes: textReader({ 'file:///cache/scan.jpg': 'JPEGBYTES' }),
    });
    const wire = asBinaryString(body);

    // The regression this module exists to fix: RN's `{ uri, name, type }`
    // part either serialized the uri STRING or threw
    // 'Unsupported FormDataPart implementation' in expo/fetch. The file's own
    // path must never reach the wire, and the bytes must be there instead.
    expect(wire).not.toContain('file:///cache/scan.jpg');
    expect(wire).not.toContain('"uri"');
    expect(wire).toContain('JPEGBYTES');
  });

  it('preserves arbitrary binary bytes untouched', async () => {
    const raw = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x80]);
    const { body } = await buildMultipartBody({
      files: [
        { field: 'image', uri: 'file:///x.bin', fileName: 'x.bin', contentType: 'image/jpeg' },
      ],
      boundary: B,
      readBytes: async () => raw,
    });

    const headerEnd = asBinaryString(body).indexOf('\r\n\r\n') + 4;
    expect(Array.from(body.slice(headerEnd, headerEnd + raw.length))).toEqual(Array.from(raw));
  });

  it('percent-escapes quotes and newlines in a picker-supplied filename', async () => {
    const { body } = await buildMultipartBody({
      files: [
        {
          field: 'file',
          uri: 'file:///odd',
          // An image-picker `asset.fileName` is attacker-adjacent input; a raw
          // quote or CRLF would forge a part header.
          fileName: 'we"ird\r\nname.jpg',
          contentType: 'image/jpeg',
        },
      ],
      boundary: B,
      readBytes: textReader({ 'file:///odd': 'X' }),
    });

    expect(asBinaryString(body)).toContain(
      `Content-Disposition: form-data; name="file"; filename="we%22ird%0D%0Aname.jpg"\r\n`,
    );
  });

  it('mints a fresh, syntactically valid boundary per call', () => {
    const a = createMultipartBoundary();
    const b = createMultipartBoundary();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^----StockPilotFormBoundary[A-Za-z0-9]{32}$/);
  });
});

describe('postMultipart', () => {
  const fetchImpl = vi.fn();

  beforeEach(() => {
    fetchImpl.mockReset();
    fetchImpl.mockResolvedValue({ ok: true, status: 200 });
  });

  it('POSTs the bytes with the boundary Content-Type and the caller headers', async () => {
    const signal = new AbortController().signal;
    const res = await postMultipart('https://api.test/api/po-imports/scan', {
      files: [{ field: 'file', uri: 'file:///a.jpg', fileName: 'a.jpg', contentType: 'image/jpeg' }],
      fields: [{ name: 'mode', value: 'combined' }],
      headers: { Authorization: 'Bearer tok' },
      signal,
      boundary: B,
      readBytes: textReader({ 'file:///a.jpg': 'A' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/api/po-imports/scan');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': `multipart/form-data; boundary=${B}`,
    });
    // A Uint8Array body is the ONE shape both transports accept: expo/fetch
    // (RequestUtils.normalizeBodyInitAsync) and RN's fetch
    // (Libraries/Network/convertRequestBody) each take their
    // ArrayBuffer.isView branch. A FormData body is what broke.
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(asBinaryString(init.body as Uint8Array)).toContain('name="file"; filename="a.jpg"');
  });

  it('refuses a caller Content-Type that would break the boundary', async () => {
    await postMultipart('https://api.test/x', {
      files: [{ field: 'file', uri: 'file:///a.jpg', fileName: 'a.jpg', contentType: 'image/jpeg' }],
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      boundary: B,
      readBytes: textReader({ 'file:///a.jpg': 'A' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      `multipart/form-data; boundary=${B}`,
    );
  });
});
