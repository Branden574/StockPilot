import { describe, expect, it, vi } from 'vitest';

import { BatchProgress, uploadWithProgress } from './upload-with-progress';

describe('BatchProgress — the honesty properties', () => {
  it('weights by size, so a big file dominates the percentage', () => {
    const batch = new BatchProgress([
      { key: 'big', weight: 9_000_000 },
      { key: 'small', weight: 1_000_000 },
    ]);

    // Finishing only the small file must NOT read as half done.
    batch.settle('small', true);
    expect(batch.percent).toBe(10);

    batch.set('big', 0.5);
    expect(batch.percent).toBe(55);
  });

  it('NEVER reports 100% when a file failed', () => {
    // The core lie this class exists to prevent: a batch where one upload died
    // must not render as complete.
    const batch = new BatchProgress([
      { key: 'a', weight: 1000 },
      { key: 'b', weight: 1000 },
    ]);

    batch.settle('a', true);
    batch.set('b', 0.8);
    batch.settle('b', false); // failed at 80%

    expect(batch.percent).not.toBe(100);
    expect(batch.percent).toBe(90);
  });

  it('reaches 100% only when every file genuinely succeeded', () => {
    const batch = new BatchProgress([
      { key: 'a', weight: 1000 },
      { key: 'b', weight: 3000 },
    ]);
    batch.settle('a', true);
    expect(batch.percent).toBeLessThan(100);
    batch.settle('b', true);
    expect(batch.percent).toBe(100);
  });

  it('holds at 99 rather than rounding up to 100 while bytes are still moving', () => {
    const batch = new BatchProgress([{ key: 'a', weight: 1_000_000 }]);
    batch.set('a', 0.996);

    // 99.6 would round to 100 and claim a finished upload that is still in
    // flight. Floor-and-hold is the whole point.
    expect(batch.percent).toBe(99);
  });

  it('never travels backwards, even if a transport re-reports a smaller loaded value', () => {
    const batch = new BatchProgress([{ key: 'a', weight: 1000 }]);
    batch.set('a', 0.7);
    expect(batch.percent).toBe(70);

    // A retry restarting at 0, or an out-of-order progress event, must not
    // rewind a bar the user already watched advance.
    batch.set('a', 0.1);
    expect(batch.percent).toBe(70);
  });

  it('clamps a nonsense fraction instead of exceeding 100', () => {
    const batch = new BatchProgress([{ key: 'a', weight: 1000 }]);
    batch.set('a', 4.2);
    expect(batch.percent).toBe(100);
  });

  it('ignores keys it does not track, rather than inventing weight', () => {
    const batch = new BatchProgress([{ key: 'a', weight: 1000 }]);
    batch.set('ghost', 1);
    batch.settle('ghost', true);
    expect(batch.percent).toBe(0);
  });

  it('treats a zero-byte file as real work so it cannot divide by zero', () => {
    const batch = new BatchProgress([{ key: 'empty', weight: 0 }]);
    expect(batch.percent).toBe(0);
    batch.settle('empty', true);
    expect(batch.percent).toBe(100);
  });

  it('reports 0 for an empty batch rather than NaN', () => {
    const batch = new BatchProgress([]);
    expect(batch.fraction).toBe(0);
    expect(batch.percent).toBe(0);
  });
});

/** Minimal XHR double: enough to drive onprogress/onload/onerror. */
function installFakeXhr() {
  const instances: Array<Record<string, unknown>> = [];
  class FakeXhr {
    status = 0;
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    headers: Record<string, string> = {};
    sent: unknown = null;
    method = '';
    url = '';
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body: unknown) {
      this.sent = body;
    }
    abort() {
      this.onabort?.();
    }
    constructor() {
      instances.push(this as unknown as Record<string, unknown>);
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
  return instances as unknown as FakeXhr[];
}

describe('uploadWithProgress', () => {
  it('PUTs with the given content type and extra headers', async () => {
    const instances = installFakeXhr();
    const promise = uploadWithProgress({
      url: 'https://example.test/o',
      body: new Blob(['x']),
      contentType: 'image/webp',
      headers: { 'x-upsert': 'true' },
    });

    const xhr = instances[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://example.test/o');
    expect(xhr.headers['Content-Type']).toBe('image/webp');
    expect(xhr.headers['x-upsert']).toBe('true');

    xhr.status = 200;
    xhr.onload!();
    await expect(promise).resolves.toEqual({ ok: true, status: 200 });
  });

  it('resolves ok:false for a non-2xx instead of throwing, matching fetch()', async () => {
    // Call sites keep their existing `if (!res.ok)` handling.
    const instances = installFakeXhr();
    const promise = uploadWithProgress({
      url: 'u',
      body: new Blob(['x']),
      contentType: 'image/webp',
    });
    const xhr = instances[0]!;
    xhr.status = 403;
    xhr.onload!();
    await expect(promise).resolves.toEqual({ ok: false, status: 403 });
  });

  it('reports only transport-provided byte counts', async () => {
    const instances = installFakeXhr();
    const seen: Array<{ loaded: number; total: number }> = [];
    const promise = uploadWithProgress({
      url: 'u',
      body: new Blob(['x']),
      contentType: 'image/webp',
      onProgress: (p) => seen.push(p),
    });
    const xhr = instances[0]!;

    xhr.upload.onprogress!({ lengthComputable: true, loaded: 25, total: 100 } as ProgressEvent);
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 80, total: 100 } as ProgressEvent);
    xhr.status = 200;
    xhr.onload!();
    await promise;

    expect(seen).toEqual([
      { loaded: 25, total: 100 },
      { loaded: 80, total: 100 },
    ]);
  });

  it('reports NOTHING when the transport cannot size the body', async () => {
    // A fabricated fraction is worse than no fraction: the caller shows
    // "Preparing…" instead of a made-up number.
    const instances = installFakeXhr();
    const seen: unknown[] = [];
    const promise = uploadWithProgress({
      url: 'u',
      body: new Blob(['x']),
      contentType: 'image/webp',
      onProgress: (p) => seen.push(p),
    });
    const xhr = instances[0]!;
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 10, total: 0 } as ProgressEvent);
    xhr.status = 200;
    xhr.onload!();
    await promise;

    expect(seen).toEqual([]);
  });

  it('rejects on a transport error rather than resolving ok:false', async () => {
    const instances = installFakeXhr();
    const promise = uploadWithProgress({
      url: 'u',
      body: new Blob(['x']),
      contentType: 'image/webp',
    });
    instances[0]!.onerror!();
    await expect(promise).rejects.toThrow(/Network error/);
  });

  it('rejects immediately when the signal is already aborted, without sending', async () => {
    const instances = installFakeXhr();
    const controller = new AbortController();
    controller.abort();
    const promise = uploadWithProgress({
      url: 'u',
      body: new Blob(['x']),
      contentType: 'image/webp',
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow(/aborted/i);
    expect(instances[0]!.sent).toBeNull();
  });
});
