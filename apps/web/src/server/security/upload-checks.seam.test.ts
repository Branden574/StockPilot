import { createDedupeFetch } from 'next/dist/server/lib/dedupe-fetch';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The seam every caller suite stands in for (review round 3, R3-3): the
// finalize check with the REAL storage reader (lib/storage-object-prefix.ts),
// through Next 16's own fetch dedupe around Node's real fetch, over a real
// socket to a loopback server that answers as the lab's storage did in lab
// walk 5: a Range inside an object is a 206 with the true Content-Range, a
// plain GET a 200 with the size, a Range that runs past the end of an object
// is never answered, and every body's end comes a moment after its bytes.
// Events and audit lines are counted (the test setup stands in for both).
// Every byte is made-up filler: a PNG with no pixels anyone could see, and a
// few archive-start bytes.
// ---------------------------------------------------------------------------

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    throw new Error('outside a request');
  }),
}));

import { STORAGE_STEP_LIMIT_MS } from '@/lib/storage-steps';
import { recordSecurityEvent } from '@/server/security/events';
import { audit } from '@/server/services/audit';
import { type LocalServer, startLocalServer } from '@/test/local-http';

import {
  checkStoredUpload,
  UPLOAD_EMPTY_MESSAGE,
  UPLOAD_NOT_CHECKED_MESSAGE,
  UPLOAD_REFUSED_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
} from './upload-checks';

const record = vi.mocked(recordSecurityEvent);
const auditMock = vi.mocked(audit);
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A PNG of `size` bytes: signature, header, one data chunk of zero filler, end. */
function png(size: number): Uint8Array {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(25);
  ihdr.set([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  new DataView(ihdr.buffer).setUint32(8, 2);
  new DataView(ihdr.buffer).setUint32(12, 3);
  ihdr.set([8, 2, 0, 0, 0], 16);
  const iend = Uint8Array.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const fill = size - sig.length - ihdr.length - iend.length - 12;
  const idat = new Uint8Array(12 + fill);
  new DataView(idat.buffer).setUint32(0, fill);
  idat.set([0x49, 0x44, 0x41, 0x54], 4);
  return concat(sig, ihdr, idat, iend);
}
const ARCHIVE_START = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

const objects = new Map<string, Uint8Array>();
/** Every request storage was asked, as "<object> <range or whole>". */
const asked: string[] = [];
let server: LocalServer;

beforeAll(async () => {
  server = await startLocalServer((req, res) => {
    const name = new URL(req.url ?? '/', 'http://storage.test').pathname.slice(1);
    const obj = objects.get(name);
    const range = req.headers.range ?? null;
    asked.push(`${name} ${range ?? 'whole'}`);
    if (!obj) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = obj;
    if (range) {
      const last = Number(/^bytes=0-(\d+)$/.exec(range)?.[1] ?? NaN);
      if (!(last < obj.byteLength)) return; // the lab's storage: never answered
      body = obj.subarray(0, last + 1);
      res.writeHead(206, {
        'content-range': `bytes 0-${last}/${obj.byteLength}`,
        'content-length': String(body.byteLength),
      });
    } else {
      res.writeHead(200, { 'content-length': String(obj.byteLength) });
    }
    res.write(body);
    setTimeout(() => res.end(), 20);
  });
  // Inside the app, fetch is Next's: the check reads through its dedupe.
  vi.stubGlobal('fetch', createDedupeFetch(globalThis.fetch));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

beforeEach(() => {
  asked.length = 0;
  record.mockImplementation(async () => undefined);
});

/** The storage client: a signed link to the loopback server, and the object's size record (or none). */
function storeFor(name: string, sizeRecord: boolean) {
  return {
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: `${server.origin}/${name}` }, error: null })),
    info: vi.fn(async () =>
      sizeRecord
        ? { data: { size: objects.get(name)!.byteLength }, error: null }
        : { data: null, error: { message: 'no record' } },
    ),
    remove: vi.fn(async (paths: string[]) => ({ data: paths.map((p) => ({ name: p })), error: null })),
  };
}

function inputFor(name: string, maxBytes = 10 * 1024 * 1024) {
  return {
    surface: 'item_photo' as const,
    accept: ['png', 'jpeg', 'webp'] as const,
    organizationId: ORG,
    maxBytes,
    removeOnRefusal: [name],
    stillNamed: vi.fn(async () => false),
    removedBy: { organizationId: ORG, userId: USER },
    unreadableMessage: 'This photo could not be read. Try uploading it again.',
  };
}

async function finalize(name: string, opts: { sizeRecord?: boolean; maxBytes?: number } = {}) {
  const store = storeFor(name, opts.sizeRecord ?? true);
  const started = performance.now();
  const out = await checkStoredUpload(store, name, inputFor(name, opts.maxBytes));
  return { out, ms: performance.now() - started, store };
}

const auditEvents = () => auditMock.mock.calls.map(([p]) => p.event);

describe('the finalize check with the real reader, through Next’s fetch, over a socket (review round 3)', () => {
  it('an honest picture over the first window is read whole and passes, in milliseconds', async () => {
    const photo = png(30798);
    objects.set('honest-large.png', photo);
    const { out, ms, store } = await finalize('honest-large.png');
    expect(out).toMatchObject({ ok: true, kind: 'png' });
    expect(out.ok && Array.from(out.bytes)).toEqual(Array.from(photo));
    expect(ms).toBeLessThan(2_000);
    expect(asked).toEqual(['honest-large.png bytes=0-4095', 'honest-large.png whole']);
    expect(store.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('an honest small picture asks only for its own bytes and passes', async () => {
    objects.set('honest-small.png', png(1136));
    const { out, ms } = await finalize('honest-small.png');
    expect(out).toMatchObject({ ok: true, kind: 'png' });
    expect(ms).toBeLessThan(2_000);
    expect(asked).toEqual(['honest-small.png bytes=0-1135']);
  });

  it('a file hidden after a picture, over the first window: refused from the whole read, removed, one event', async () => {
    objects.set('hidden.png', concat(png(30798), ARCHIVE_START));
    const { out, ms, store } = await finalize('hidden.png');
    expect(out).toEqual({ ok: false, family: 'hidden_file', message: UPLOAD_REFUSED_MESSAGE });
    expect(ms).toBeLessThan(2_000);
    expect(store.remove).toHaveBeenCalledWith(['hidden.png']);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ reason: 'upload_hidden_file', organizationId: ORG });
    expect(auditEvents()).toEqual(['security.upload_refused_removed']);
  });

  it('an empty object: refused at once from its size, removed, an audit line, no event, nothing read', async () => {
    objects.set('empty.png', new Uint8Array(0));
    const { out, store } = await finalize('empty.png');
    expect(out).toEqual({ ok: false, family: null, message: UPLOAD_EMPTY_MESSAGE });
    expect(asked).toEqual([]);
    expect(store.createSignedUrl).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledWith(['empty.png']);
    expect(record).not.toHaveBeenCalled();
    expect(auditEvents()).toEqual(['security.upload_refused_removed']);
  });

  it('an object over the ceiling: refused from its size record, nothing of its body asked, removed', async () => {
    objects.set('over.png', png(20000));
    const { out, store } = await finalize('over.png', { maxBytes: 10000 });
    expect(out).toEqual({ ok: false, family: null, message: UPLOAD_TOO_LARGE_MESSAGE });
    expect(asked).toEqual([]);
    expect(store.remove).toHaveBeenCalledWith(['over.png']);
    expect(record).not.toHaveBeenCalled();
  });

  it('a storage that never answers the window: "could not be checked" at the step limit, nothing removed or recorded', async () => {
    // With no size record the window asks for 4 KB of a smaller object,
    // which the lab's storage never answers.
    objects.set('unanswered.png', png(1136));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const store = storeFor('unanswered.png', false);
      let answer: unknown;
      const finalized = checkStoredUpload(store, 'unanswered.png', inputFor('unanswered.png')).then((v) => {
        answer = v;
      });
      await vi.advanceTimersByTimeAsync(STORAGE_STEP_LIMIT_MS - 1);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await finalized;
      expect(answer).toEqual({ ok: false, family: null, message: UPLOAD_NOT_CHECKED_MESSAGE });
      expect(store.remove).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
