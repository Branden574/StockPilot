import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createDedupeFetch } from 'next/dist/server/lib/dedupe-fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sniffImage } from './image-signature';
import {
  fetchObjectPrefix,
  fetchObjectWhole,
  fetchObjectWindow,
  isStorageReadTimedOut,
  SNIFF_PREFIX_BYTES,
  STORAGE_READ_TIMED_OUT,
  STORAGE_STEP_LIMIT_MS,
  STORAGE_WHOLE_READ_LIMIT_MS,
  type StorageReadTimedOut,
} from './storage-object-prefix';

/**
 * The helper is the storage-read seam for the magic-byte sniff callers
 * (item-images.record, maintenance-attachments.finalize, setOrgLogoUrlAction,
 * and verifyStoredDocumentOrDelete for po-attachments and order-attachments),
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

/**
 * The storage client: a signed URL, and the object's record. Given a size,
 * the record states it (lab walk 5: the size is asked first); without one it
 * answers an error, the storage that gives no size, and the window read
 * learns the size from its own headers, as it always did.
 */
function okSigner(size?: number) {
  return {
    createSignedUrl: vi.fn(async () => ({
      data: { signedUrl: 'https://supa.example.com/storage/v1/object/sign/b/x?token=t' },
      error: null,
    })),
    info: vi.fn(async () =>
      size === undefined
        ? { data: null, error: { message: 'no record' } }
        : { data: { size }, error: null },
    ),
  };
}

/** The answer, when it is not the timed-out one: a test that expects an answer must not get that. */
function inTime<T>(value: T | StorageReadTimedOut): T {
  expect(isStorageReadTimedOut(value)).toBe(false);
  return value as T;
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
    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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
    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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

    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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
    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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
    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
    expect(out).toEqual({ prefix: new Uint8Array(0), totalSize: 0 });
  });

  it('a signing refusal is null — the finalize-time existence check the old download() provided', async () => {
    const signer = {
      createSignedUrl: vi.fn(async () => ({ data: null, error: { message: 'Object not found' } })),
      info: vi.fn(async () => ({ data: null, error: { message: 'Object not found' } })),
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

  // L65a: the 206 branch read its body outside any try, so a body read that
  // failed (a dropped connection mid-body) threw out of a function whose
  // contract is null on any failure, and record() answered an internal error.
  it('a 206 whose body read rejects is null, not a thrown error', async () => {
    const res = new Response(bodyOf(objectBytes(26)), {
      status: 206,
      headers: { 'content-range': 'bytes 0-25/26' },
    });
    vi.spyOn(res, 'arrayBuffer').mockRejectedValue(new TypeError('terminated'));
    const fetchImpl = vi.fn(async () => res);
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

    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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

    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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

    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
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

/** A body that counts what was pulled from it and whether it was cancelled. */
function countingStream(full: Uint8Array, chunk = 1024) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= full.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(full.subarray(seen.pulled, seen.pulled + chunk));
      seen.pulled += chunk;
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

describe('a ceiling on the read (part 6)', () => {
  it('206: a stated size over the ceiling is answered from the header alone, the body never read', async () => {
    const { stream, seen } = countingStream(objectBytes(4096));
    const fetchImpl = vi.fn(async () =>
      new Response(stream, { status: 206, headers: { 'content-range': 'bytes 0-4095/20000' } }),
    );
    const out = inTime(await fetchObjectWindow(okSigner(), PATH, fetchImpl as unknown as typeof fetch, {
      maxTotalBytes: 10000,
    }));
    expect(out).toEqual({ prefix: new Uint8Array(0), totalSize: 20000, overLimit: true });
    expect(seen.pulled).toBeLessThanOrEqual(1024);
    expect(seen.cancelled).toBe(true);
  });

  it('200 (range ignored): a Content-Length over the ceiling is refused the same way, nothing buffered', async () => {
    const full = objectBytes(20000);
    const { stream, seen } = countingStream(full);
    const fetchImpl = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'content-length': '20000' } }),
    );
    const out = inTime(await fetchObjectPrefix(okSigner(), PATH, fetchImpl as unknown as typeof fetch, {
      maxTotalBytes: 10000,
    }));
    expect(out).toMatchObject({ totalSize: 20000, overLimit: true });
    expect(out!.prefix.byteLength).toBe(0);
    expect(seen.pulled).toBeLessThan(full.byteLength);
    expect(seen.cancelled).toBe(true);
    // Never widened to a whole read either.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a size at the ceiling is read as before; no ceiling is no limit', async () => {
    const full = objectBytes(10240);
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(full.subarray(0, 4096)), {
        status: 206,
        headers: { 'content-range': 'bytes 0-4095/10240' },
      }),
    );
    const at = inTime(await fetchObjectWindow(okSigner(), PATH, fetchImpl as unknown as typeof fetch, {
      maxTotalBytes: 10240,
    }));
    expect(at).toMatchObject({ totalSize: 10240 });
    expect(at).not.toHaveProperty('overLimit');
    const none = inTime(await fetchObjectWindow(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
    expect(none).not.toHaveProperty('overLimit');
  });

  it('the window is never widened: an undecided JPEG window stays a window', async () => {
    const jpeg = new Uint8Array(8209);
    jpeg.set([0xff, 0xd8, 0xff, 0xe1, 0x20, 0x02]);
    const fetchImpl = vi.fn(async () =>
      new Response(bodyOf(jpeg.subarray(0, 4096)), {
        status: 206,
        headers: { 'content-range': 'bytes 0-4095/8209' },
      }),
    );
    const out = inTime(await fetchObjectWindow(okSigner(), PATH, fetchImpl as unknown as typeof fetch));
    expect(out!.prefix.byteLength).toBe(4096);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchObjectWhole (part 6)', () => {
  it('reads exactly the stated size and cancels the rest', async () => {
    const full = objectBytes(10240);
    const { stream, seen } = countingStream(concat2(full, new Uint8Array(50_000)));
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200, headers: { 'content-length': '10240' } }),
    );
    const out = inTime(await fetchObjectWhole(okSigner(), PATH, 10240, fetchImpl as unknown as typeof fetch));
    expect(out!.byteLength).toBe(10240);
    expect(Array.from(out!.subarray(0, 8))).toEqual(Array.from(full.subarray(0, 8)));
    expect(seen.pulled).toBeLessThanOrEqual(10240 + 1024);
    expect(seen.cancelled).toBe(true);
  });

  it('with no stated length, the body must end by itself at the size: one with more is never judged as the whole (review round 2, F3)', async () => {
    const full = objectBytes(10240);
    const unstated = (bytes: Uint8Array) =>
      vi.fn(async () => {
        const res = new Response(countingStream(bytes).stream, { status: 200 });
        res.headers.delete('content-length');
        return res;
      });
    // The object grew after the window read: its first 10240 bytes are not the object.
    const longer = unstated(concat2(full, new Uint8Array(50_000)));
    expect(await fetchObjectWhole(okSigner(), PATH, 10240, longer as unknown as typeof fetch)).toBeNull();
    // One byte more is enough to tell.
    const oneMore = unstated(concat2(full, new Uint8Array(1)));
    expect(await fetchObjectWhole(okSigner(), PATH, 10240, oneMore as unknown as typeof fetch)).toBeNull();
    // A body that ends by itself at the stated size is the whole object.
    const exact = unstated(full);
    const out = inTime(await fetchObjectWhole(okSigner(), PATH, 10240, exact as unknown as typeof fetch));
    expect(out!.byteLength).toBe(10240);
  });

  it('a body that ends short, a length other than the stated one, or a failure is null', async () => {
    const full = objectBytes(10240);
    const short = vi.fn(async () => new Response(bodyOf(full.subarray(0, 5000)), { status: 200 }));
    expect(await fetchObjectWhole(okSigner(), PATH, 10240, short as unknown as typeof fetch)).toBeNull();
    const other = vi.fn(async () =>
      new Response(bodyOf(full), { status: 200, headers: { 'content-length': '99999' } }),
    );
    expect(await fetchObjectWhole(okSigner(), PATH, 10240, other as unknown as typeof fetch)).toBeNull();
    const gone = vi.fn(async () => new Response('gone', { status: 404 }));
    expect(await fetchObjectWhole(okSigner(), PATH, 10240, gone as unknown as typeof fetch)).toBeNull();
    const refused = {
      createSignedUrl: vi.fn(async () => ({ data: null, error: { message: 'no' } })),
      info: vi.fn(async () => ({ data: null, error: { message: 'no' } })),
    };
    expect(await fetchObjectWhole(refused, PATH, 10240, short as unknown as typeof fetch)).toBeNull();
  });
});

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// ─────────────────────────── lab walk 5 ───────────────────────────

/**
 * A body the way one comes off the network (undici's is a byte stream): its
 * bytes are there, and its end arrives a moment later.
 */
function networkBody(bytes: Uint8Array, chunk = 16384): ReadableStream<Uint8Array> {
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
      setTimeout(() => {
        try {
          controller.close();
        } catch {
          // cancelled before its end arrived
        }
      }, 20);
    },
  });
}

/** A request that is never answered, until its signal aborts it. */
function neverAnswered(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

/**
 * Storage as the lab's answered it (lab walk 5): a Range inside the object
 * is a 206 with the true Content-Range, a plain GET a 200 with the size, and
 * a Range that runs past the end of the object (any Range on an empty one)
 * is never answered. Each request's Range and signal are kept.
 */
function labStorage(object: Uint8Array, opts: { ignoresRange?: boolean } = {}) {
  const calls: Array<{ range: string | null; signal: AbortSignal | null }> = [];
  const impl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const range = ((init?.headers ?? {}) as Record<string, string>).range ?? null;
    calls.push({ range, signal: init?.signal ?? null });
    if (range !== null && !opts.ignoresRange) {
      const last = Number(/^bytes=0-(\d+)$/.exec(range)?.[1] ?? NaN);
      if (!(last < object.byteLength)) return neverAnswered(init);
      return new Response(networkBody(object.subarray(0, last + 1)), {
        status: 206,
        headers: { 'content-range': `bytes 0-${last}/${object.byteLength}` },
      });
    }
    return new Response(networkBody(object), {
      status: 200,
      headers: { 'content-length': String(object.byteLength) },
    });
  };
  return { impl: impl as typeof fetch, calls };
}

/** Next 16's own fetch dedupe around a fetch: a GET with options and no signal has its body teed, one branch kept. */
function nextsFetch(inner: typeof fetch): typeof fetch {
  return createDedupeFetch(inner) as typeof fetch;
}

/** A fetch that keeps a copy of every body it hands out, signal or not: the class whose cancel never settles. */
function keepsACopy(inner: typeof fetch): typeof fetch {
  const kept: Response[] = [];
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(url, init);
    kept.push(res.clone());
    return res;
  }) as typeof fetch;
}

/** Whether a promise settles inside `ms` (real time). */
async function settlesWithin<T>(ms: number, p: Promise<T>): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ settled: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

describe('a fetch that keeps a copy of the body, as Next 16 does inside the app (lab walk 5, F2)', () => {
  it('the doubles behave as the app saw: a read that stops at the size and awaits its cancel never settles', async () => {
    const object = objectBytes(30798);
    for (const wrap of [nextsFetch, keepsACopy]) {
      const res = await wrap(labStorage(object).impl)('https://storage.example/o', { cache: 'no-store' });
      const reader = res.body!.getReader();
      let got = 0;
      while (got < object.byteLength) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
      }
      expect(got).toBe(object.byteLength);
      expect((await settlesWithin(300, reader.cancel())).settled).toBe(false);
    }
    // The same read off a fetch that keeps nothing settles at once.
    const plain = await labStorage(object).impl('https://storage.example/o', { cache: 'no-store' });
    const reader = plain.body!.getReader();
    await reader.read();
    expect((await settlesWithin(300, reader.cancel())).settled).toBe(true);
  });

  for (const [name, wrap] of [
    ["Next's fetch", nextsFetch],
    ['a fetch that keeps a copy even with a signal', keepsACopy],
  ] as const) {
    describe(`through ${name}`, () => {
      it('the whole read answers with the whole object', async () => {
        const object = objectBytes(30798);
        const storage = labStorage(object);
        const out = await settlesWithin(1000, fetchObjectWhole(okSigner(30798), PATH, 30798, wrap(storage.impl)));
        expect(out.settled).toBe(true);
        expect(out.settled && Array.from(inTime(out.value)!)).toEqual(Array.from(object));
      });

      it("the widened read of a window the sniff cannot decide answers", async () => {
        const jpeg = new Uint8Array(8209);
        jpeg.set([0xff, 0xd8, 0xff, 0xe1, 0x20, 0x02]);
        jpeg.fill(0x45, 6, 6 + 8192);
        jpeg.set([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01, 0x00], 6 + 8192);
        const storage = labStorage(jpeg);
        const out = await settlesWithin(1000, fetchObjectPrefix(okSigner(8209), PATH, wrap(storage.impl)));
        expect(out.settled).toBe(true);
        expect(out.settled && inTime(out.value)).toMatchObject({ totalSize: 8209 });
        expect(storage.calls.map((c) => c.range)).toEqual(['bytes=0-4095', null]);
      });

      it('an object over the ceiling answers, from the window when storage keeps no size record', async () => {
        const storage = labStorage(objectBytes(20000));
        const out = await settlesWithin(
          1000,
          fetchObjectWindow(okSigner(), PATH, wrap(storage.impl), { maxTotalBytes: 10000 }),
        );
        expect(out.settled && out.value).toEqual({ prefix: new Uint8Array(0), totalSize: 20000, overLimit: true });
      });

      it('a window read from a storage that ignores the range answers with the window', async () => {
        const storage = labStorage(objectBytes(20000), { ignoresRange: true });
        const out = await settlesWithin(1000, fetchObjectWindow(okSigner(20000), PATH, wrap(storage.impl)));
        expect(out.settled).toBe(true);
        expect(out.settled && inTime(out.value)!.prefix.byteLength).toBe(SNIFF_PREFIX_BYTES);
      });
    });
  }

  it("every read passes its own signal (Next's fetch keeps no copy of such a body), and each is aborted once its step is over", async () => {
    const object = objectBytes(30798);
    const storage = labStorage(object);
    const viaNext = nextsFetch(storage.impl);
    const head = inTime(await fetchObjectWindow(okSigner(30798), PATH, viaNext))!;
    inTime(await fetchObjectWhole(okSigner(30798), PATH, head.totalSize, viaNext));
    expect(storage.calls).toHaveLength(2);
    for (const call of storage.calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal!.aborted).toBe(true);
    }
  });
});

describe('the size first (lab walk 5, F1)', () => {
  it('an empty object is answered from its size at once: no signed URL, no read', async () => {
    const signer = okSigner(0);
    const storage = labStorage(new Uint8Array(0));
    const out = await settlesWithin(1000, fetchObjectWindow(signer, PATH, storage.impl, { maxTotalBytes: 100 }));
    expect(out.settled && out.value).toEqual({ prefix: new Uint8Array(0), totalSize: 0 });
    expect(signer.createSignedUrl).not.toHaveBeenCalled();
    expect(storage.calls).toHaveLength(0);
    expect(inTime(await fetchObjectPrefix(okSigner(0), PATH, storage.impl))).toEqual({
      prefix: new Uint8Array(0),
      totalSize: 0,
    });
  });

  it('a small object asks for no byte past its end, so the storage answers', async () => {
    const object = objectBytes(1136);
    const storage = labStorage(object);
    const out = await settlesWithin(1000, fetchObjectWindow(okSigner(1136), PATH, storage.impl));
    expect(out.settled && inTime(out.value)).toEqual({ prefix: object, totalSize: 1136 });
    expect(storage.calls.map((c) => c.range)).toEqual(['bytes=0-1135']);
  });

  it('an object of the window or more asks for the window, as before', async () => {
    for (const size of [4096, 10240]) {
      const storage = labStorage(objectBytes(size));
      inTime(await fetchObjectWindow(okSigner(size), PATH, storage.impl));
      expect(storage.calls.map((c) => c.range)).toEqual(['bytes=0-4095']);
    }
  });

  it('a recorded size over the ceiling is answered from the record: nothing minted, nothing read', async () => {
    const signer = okSigner(20000);
    const fetchImpl = vi.fn();
    const out = await fetchObjectWindow(signer, PATH, fetchImpl as unknown as typeof fetch, { maxTotalBytes: 10000 });
    expect(out).toEqual({ prefix: new Uint8Array(0), totalSize: 20000, overLimit: true });
    expect(signer.createSignedUrl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a window that names another size than the record is not this object: null', async () => {
    const storage = labStorage(objectBytes(20000));
    expect(await fetchObjectWindow(okSigner(10240), PATH, storage.impl)).toBeNull();
    const ignoring = labStorage(objectBytes(20000), { ignoresRange: true });
    expect(await fetchObjectWindow(okSigner(10240), PATH, ignoring.impl)).toBeNull();
  });

  it('with no size record the window learns the size from its headers, as before', async () => {
    const storage = labStorage(objectBytes(10240));
    expect(inTime(await fetchObjectWindow(okSigner(), PATH, storage.impl))).toMatchObject({ totalSize: 10240 });
    expect(storage.calls.map((c) => c.range)).toEqual(['bytes=0-4095']);
  });
});

describe('a hard time limit on every storage step (lab walk 5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = (): Promise<never> => new Promise<never>(() => undefined);

  /** Runs `start` with fake time moved `ms` on, and says whether it had answered before then. */
  async function at<T>(ms: number, start: () => Promise<T>): Promise<{ before: boolean; value: T }> {
    vi.useFakeTimers();
    let answered = false;
    const p = start().then((v) => {
      answered = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    const before = answered;
    await vi.advanceTimersByTimeAsync(1);
    return { before, value: await p };
  }

  it('a size record that never answers: timed out at the step limit, nothing else asked', async () => {
    const signer = { ...okSigner(), info: vi.fn(never) };
    const fetchImpl = vi.fn();
    const out = await at(STORAGE_STEP_LIMIT_MS, () =>
      fetchObjectWindow(signer, PATH, fetchImpl as unknown as typeof fetch),
    );
    expect(out).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
    expect(signer.createSignedUrl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a signed URL that never comes: timed out, for the window and for the whole read', async () => {
    const signer = { ...okSigner(10240), createSignedUrl: vi.fn(never) };
    const fetchImpl = vi.fn();
    const window = await at(STORAGE_STEP_LIMIT_MS, () =>
      fetchObjectWindow(signer, PATH, fetchImpl as unknown as typeof fetch),
    );
    expect(window).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
    const whole = await at(STORAGE_STEP_LIMIT_MS, () =>
      fetchObjectWhole(signer, PATH, 10240, fetchImpl as unknown as typeof fetch),
    );
    expect(whole).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a window read that is never answered (the lab, on a range past the end): timed out, its request aborted', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return neverAnswered(init);
    });
    const out = await at(STORAGE_STEP_LIMIT_MS, () =>
      fetchObjectWindow(okSigner(), PATH, fetchImpl as unknown as typeof fetch),
    );
    expect(out).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it('a window body that stops coming: timed out, its request aborted', async () => {
    let signal: AbortSignal | undefined;
    const stalled = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        pull: () => never(),
      });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init!.signal!;
      return new Response(stalled(), { status: 200, headers: { 'content-length': '10240' } });
    });
    const out = await at(STORAGE_STEP_LIMIT_MS, () =>
      fetchObjectWindow(okSigner(10240), PATH, fetchImpl as unknown as typeof fetch),
    );
    expect(out).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
    expect(signal!.aborted).toBe(true);
  });

  it('a whole read whose body stops coming: timed out at the whole-read limit, its request aborted', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init!.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4096));
          },
          pull: () => never(),
        }),
        { status: 200, headers: { 'content-length': '10240' } },
      );
    });
    const out = await at(STORAGE_WHOLE_READ_LIMIT_MS, () =>
      fetchObjectWhole(okSigner(10240), PATH, 10240, fetchImpl as unknown as typeof fetch),
    );
    expect(out).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
    expect(signal!.aborted).toBe(true);
  });

  it('the widened read of an undecided window has the whole-read limit too', async () => {
    const jpeg = new Uint8Array(8209);
    jpeg.set([0xff, 0xd8, 0xff, 0xe1, 0x20, 0x02]);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = ((init?.headers ?? {}) as Record<string, string>).range;
      if (range) {
        return new Response(bodyOf(jpeg.subarray(0, 4096)), {
          status: 206,
          headers: { 'content-range': 'bytes 0-4095/8209' },
        });
      }
      return neverAnswered(init);
    });
    const out = await at(STORAGE_WHOLE_READ_LIMIT_MS, () =>
      fetchObjectPrefix(okSigner(8209), PATH, fetchImpl as unknown as typeof fetch),
    );
    expect(out).toEqual({ before: false, value: STORAGE_READ_TIMED_OUT });
  });
});

/**
 * B29: the bucket sizes the module's comments give are the buckets' own
 * file_size_limit, as the migrations set it. The header said 15 MB for
 * maintenance-photos, a bucket 0315 created at 10 MB. Every "<N> MB for
 * <bucket>[ and <bucket>]" in storage-object-prefix.ts is checked against the
 * last migration that sets that bucket's limit.
 */
describe("the comments give each bucket's real size limit", () => {
  const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../supabase/migrations');

  /** The limit, in MB, the last migration to set one gives `bucket`. A
   *  statement that sets it in a form this cannot read fails the test rather
   *  than being skipped. */
  function migratedLimitMb(bucket: string): number | null {
    let mb: number | null = null;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '');
      for (const statement of sql.split(';')) {
        if (!/storage\.buckets/.test(statement) || !statement.includes('file_size_limit')) continue;
        if (!statement.includes(`'${bucket}'`)) continue;
        const sizes = [...statement.matchAll(/(\d+)\s*\*\s*1024\s*\*\s*1024/g)];
        if (sizes.length !== 1) throw new Error(`${file}: cannot read the limit for ${bucket}`);
        mb = Number(sizes[0]![1]);
      }
    }
    return mb;
  }

  /** Every "<N> MB for <bucket>[ and <bucket>]" the source states. */
  function statedLimits(): Array<{ bucket: string; mb: number }> {
    const text = readFileSync(path.resolve(__dirname, 'storage-object-prefix.ts'), 'utf8')
      .replace(/\n\s*\*\s?/g, ' ')
      .replace(/\s+/g, ' ');
    const BUCKET = '[a-z]+(?:-[a-z]+)+';
    const claim = new RegExp(`(\\d+) MB for (${BUCKET}(?: and ${BUCKET})*)`, 'g');
    return [...text.matchAll(claim)].flatMap((m) =>
      m[2]!.split(' and ').map((bucket) => ({ bucket, mb: Number(m[1]) })),
    );
  }

  it('reads the limits the migrations set (a vacuous reader would prove nothing)', () => {
    expect(
      ['maintenance-photos', 'item-images', 'org-logos', 'po-attachments', 'order-attachments'].map(
        migratedLimitMb,
      ),
    ).toEqual([10, 10, 5, 15, 15]);
  });

  it('every size the comments give is the one its bucket has', () => {
    const stated = statedLimits();
    expect(stated.map((s) => s.bucket)).toContain('maintenance-photos');
    for (const { bucket, mb } of stated) {
      expect(`${bucket}: ${mb} MB`).toBe(`${bucket}: ${migratedLimitMb(bucket)} MB`);
    }
  });
});
