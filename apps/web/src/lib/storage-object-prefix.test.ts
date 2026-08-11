import { describe, expect, it, vi } from 'vitest';

import { sniffImage } from './image-signature';
import { fetchObjectPrefix, SNIFF_PREFIX_BYTES } from './storage-object-prefix';

/**
 * The helper is the storage-read seam for the three magic-byte sniff callers
 * (item-images.record, maintenance-attachments.finalize, setOrgLogoUrlAction),
 * so its two load-bearing properties are proven here against a stubbed fetch:
 *
 *   1. the returned totalSize is the object's FULL size — from Content-Range
 *      on a 206, from Content-Length on a 200 — never the prefix's length;
 *   2. when the server ignores the Range header (200), the body stream is
 *      read only up to the prefix and then CANCELLED, not buffered whole.
 *
 * Sizes are literal-pinned (10240 full / 4096 prefix): an implementation that
 * confused the two would return 4096 where 10240 is asserted.
 */

const PATH = 'org-1/items/item-1/master.png';

function okSigner() {
  return {
    createSignedUrl: vi.fn(async () => ({
      data: { signedUrl: 'https://supa.example.com/storage/v1/object/sign/b/x?token=t' },
      error: null,
    })),
  };
}

/** 10240 deterministic bytes whose head is the PNG signature — enough to
 *  assert the prefix is byte-identical to the object's LEADING bytes. */
function objectBytes(size = 10240): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i += 1) b[i] = i % 251;
  return b;
}

/** Copies the bytes into a plain ArrayBuffer for the Response constructor —
 *  this repo's DOM lib types Uint8Array<ArrayBufferLike> outside BodyInit. */
function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('fetchObjectPrefix', () => {
  it('sends the exact Range header for the leading 4096 bytes', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(objectBytes().subarray(0, 4096)), {
        status: 206,
        headers: { 'content-range': 'bytes 0-4095/10240' },
      }),
    );
    await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://supa.example.com/storage/v1/object/sign/b/x?token=t',
      expect.objectContaining({ headers: { range: 'bytes=0-4095' } }),
    );
  });

  it('206 — returns the prefix bytes verbatim and the FULL size from Content-Range (10240, not 4096)', async () => {
    const full = objectBytes(10240);
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(full.subarray(0, 4096)), {
        status: 206,
        headers: { 'content-range': 'bytes 0-4095/10240' },
      }),
    );
    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).not.toBeNull();
    expect(out!.totalSize).toBe(10240);
    expect(out!.totalSize).not.toBe(4096);
    expect(out!.prefix.byteLength).toBe(4096);
    expect(Array.from(out!.prefix.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('206 smaller than the window — a 26-byte object yields a 26-byte prefix and totalSize 26', async () => {
    const full = objectBytes(26);
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(full), {
        status: 206,
        headers: { 'content-range': 'bytes 0-25/26' },
      }),
    );
    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ prefix: full, totalSize: 26 });
  });

  it('206 without a parseable Content-Range fails CLOSED (null) — the full size cannot be invented', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(objectBytes(100)), { status: 206 }),
    );
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('206 whose Content-Range total contradicts the body (bytes 0-4095/5 with 4096 bytes) fails CLOSED', async () => {
    // A total smaller than the range just served is self-contradictory;
    // trusting it would record byte_size=5 for a 4096+-byte object downstream.
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(objectBytes(4096)), {
        status: 206,
        headers: { 'content-range': 'bytes 0-4095/5' },
      }),
    );
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('200 (server ignores Range) — slices the first 4096 bytes off the STREAM without buffering the rest, cancels the reader, and takes the full size from Content-Length', async () => {
    const full = objectBytes(10240);
    const CHUNK = 1024;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= full.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(full.subarray(pulled, pulled + CHUNK));
        pulled += CHUNK;
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'content-length': '10240' } }),
    );

    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).not.toBeNull();
    expect(out!.totalSize).toBe(10240);
    expect(out!.prefix.byteLength).toBe(SNIFF_PREFIX_BYTES);
    expect(Array.from(out!.prefix)).toEqual(Array.from(full.subarray(0, SNIFF_PREFIX_BYTES)));
    // The non-buffering property, pinned: only the prefix's worth of chunks
    // was pulled (readers run one pull ahead, so allow exactly one extra
    // chunk), and the remainder of the stream was cancelled, not drained.
    expect(pulled).toBeLessThanOrEqual(SNIFF_PREFIX_BYTES + CHUNK);
    expect(pulled).toBeLessThan(full.byteLength);
    expect(cancelled).toBe(true);
  });

  it('200 shorter than the window — the whole (small) body becomes the prefix; Content-Length is still the size of record', async () => {
    const full = objectBytes(26);
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(full), { status: 200, headers: { 'content-length': '26' } }),
    );
    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).not.toBeNull();
    expect(out!.totalSize).toBe(26);
    expect(Array.from(out!.prefix)).toEqual(Array.from(full));
  });

  it('200 without Content-Length fails CLOSED (null) — a size the caller records must never be guessed', async () => {
    // Response would synthesize a content-length for a byte body; force the
    // missing-header case with an explicit stream body.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(objectBytes(26));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    res.headers.delete('content-length');
    const fetchImpl = vi.fn(async () => res);
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('416 with a zero total — a ZERO-BYTE object — is readable-but-empty: empty prefix, totalSize 0 (so callers route it down delete-the-fake, not object-missing)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 416, headers: { 'content-range': 'bytes */0' } }),
    );
    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ prefix: new Uint8Array(0), totalSize: 0 });
  });

  it('a signing refusal is null — the finalize-time existence check the old download() provided', async () => {
    const signer = {
      createSignedUrl: vi.fn(async () => ({ data: null, error: { message: 'Object not found' } })),
    };
    const fetchImpl = vi.fn();
    expect(await fetchObjectPrefix(signer, PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a non-2xx object response is null', async () => {
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 404 }));
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('a thrown fetch (network failure) is null, never an exception the caller must special-case', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});

/**
 * THE INDETERMINATE-WINDOW FALLBACK (fix-wave: Important 1).
 *
 * A real camera-original JPEG can carry more pre-SOF metadata (EXIF thumbnail,
 * ICC, XMP) than the 4096-byte window, so the window alone sniffs as null —
 * and the callers DELETE on null. The helper must therefore fall back to a
 * full read when (and ONLY when) the window's sniff is indeterminate, so that
 * verdicts match the old full-download behavior for every legitimate file
 * while fakes and well-formed images stay a single 4 KB read.
 */
describe('fetchObjectPrefix — indeterminate-window fallback', () => {
  /** A JPEG whose SOF sits past the window: SOI + one APP1 (EXIF) segment
   *  with an 8192-byte body, then a SOF0 declaring 4x5. Total size 8209 —
   *  every size below is literal-pinned against these bytes. */
  function exifHeavyJpeg(): Uint8Array {
    const metaBytes = 8192;
    const app1Len = metaBytes + 2;
    const b = new Uint8Array(6 + metaBytes + 11);
    b.set([0xff, 0xd8, 0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff]);
    b.fill(0x45, 6, 6 + metaBytes);
    b.set([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00], 6 + metaBytes);
    return b;
  }

  /** First call: 206 with the leading window. Second call: whatever `second`
   *  returns. Asserting on the mock's calls pins the fallback's shape. */
  function twoPhaseFetch(full: Uint8Array, second: () => Response) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.range) {
        return new Response(bodyOf(full.subarray(0, SNIFF_PREFIX_BYTES)), {
          status: 206,
          headers: { 'content-range': `bytes 0-4095/${full.byteLength}` },
        });
      }
      return second();
    });
  }

  it('a JPEG with >4 KB of pre-SOF metadata: the window is indeterminate, so a SECOND, range-less fetch pulls the WHOLE object — and the returned bytes now sniff as the jpeg they always were (totalSize 8209, prefix 8209, NOT 4096)', async () => {
    const full = exifHeavyJpeg();
    expect(full.byteLength).toBe(8209);
    const fetchImpl = twoPhaseFetch(full, () =>
      new Response(bodyOf(full), { status: 200, headers: { 'content-length': '8209' } }),
    );

    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).not.toBeNull();
    expect(out!.totalSize).toBe(8209);
    expect(out!.prefix.byteLength).toBe(8209);
    expect(Array.from(out!.prefix)).toEqual(Array.from(full));
    // The property the whole fallback exists for: the caller's sniff of this
    // prefix ACCEPTS the file instead of deleting it.
    expect(sniffImage(out!.prefix)).toEqual({ kind: 'jpeg', width: 4, height: 5 });
    // Exactly two fetches: the ranged window, then the range-less full read.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondInit = fetchImpl.mock.calls[1]![1] as RequestInit | undefined;
    expect((secondInit?.headers as Record<string, string> | undefined)?.range).toBeUndefined();
  });

  it('a DECIDABLE window never triggers a second fetch: a PNG (verdict inside 26 bytes) of a 10240-byte object is one ranged read, exactly as before the fallback existed', async () => {
    // A real PNG head (the objectBytes fixture carries the signature but a
    // garbage IHDR tag, which is a DEFINITIVE null — also a one-fetch case,
    // but the decided-image case is the one that must be pinned cheap).
    const full = new Uint8Array(10240);
    full.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    full.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // IHDR
    new DataView(full.buffer).setUint32(16, 2);
    new DataView(full.buffer).setUint32(20, 3);
    const fetchImpl = twoPhaseFetch(full, () => {
      throw new Error('the fallback must not fire for a decided window');
    });

    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).not.toBeNull();
    expect(out!.totalSize).toBe(10240);
    expect(out!.prefix.byteLength).toBe(SNIFF_PREFIX_BYTES);
    expect(sniffImage(out!.prefix)).toEqual({ kind: 'png', width: 2, height: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a DEFINITIVE fake never triggers a second fetch either — an attacker cannot make the server buffer the full object by uploading garbage', async () => {
    const full = new Uint8Array(10240).fill(0x41); // 'AAAA…', no image signature
    const fetchImpl = twoPhaseFetch(full, () => {
      throw new Error('the fallback must not fire for a definitive fake');
    });

    const out = await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch);
    expect(out).not.toBeNull();
    expect(out!.prefix.byteLength).toBe(SNIFF_PREFIX_BYTES);
    expect(sniffImage(out!.prefix)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a failed fallback read is null — fail CLOSED as unreadable (the callers no-delete path), never a verdict on a partial body', async () => {
    const full = exifHeavyJpeg();
    const fetchImpl = twoPhaseFetch(full, () => new Response('gone', { status: 403 }));
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it('a fallback stream that ends short of the attested size is null for the same reason — a truncated second read must not condemn the file', async () => {
    const full = exifHeavyJpeg();
    const fetchImpl = twoPhaseFetch(full, () =>
      new Response(bodyOf(full.subarray(0, 5000)), {
        status: 200,
        headers: { 'content-length': '8209' },
      }),
    );
    expect(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
