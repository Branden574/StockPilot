import { describe, expect, it, vi } from 'vitest';

import { uploadVideoMaster, type VideoUploadProgress } from './upload-video-master';

/** Minimal XHR double — same shape as lib/upload-with-progress.test.ts,
 *  because this test drives the SAME helper the video path is wired to. */
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
  return instances as unknown as Array<{
    status: number;
    upload: { onprogress: ((e: ProgressEvent) => void) | null };
    onload: (() => void) | null;
    headers: Record<string, string>;
    sent: unknown;
    method: string;
    url: string;
  }>;
}

describe('uploadVideoMaster — the video path is wired to the honest XHR helper', () => {
  it('PUTs the File itself to the presigned URL (streamed — never buffered into an ArrayBuffer)', async () => {
    const instances = installFakeXhr();
    const file = new Blob(['0123456789'], { type: 'video/mp4' });
    const promise = uploadVideoMaster({
      signedUrl: 'https://storage.test/procedure-videos/signed',
      file,
      contentType: 'video/mp4',
    });
    const xhr = instances[0]!;

    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://storage.test/procedure-videos/signed');
    expect(xhr.headers['Content-Type']).toBe('video/mp4');
    // The 1 GB guarantee: the EXACT Blob instance goes to xhr.send() — any
    // arrayBuffer()/copy step would hand XHR a different object.
    expect(xhr.sent).toBe(file);

    xhr.status = 200;
    xhr.onload!();
    await expect(promise).resolves.toEqual({ ok: true, status: 200 });
  });

  it('reports a MONOTONIC, literal percent sequence from transport events, holding 99 until success', async () => {
    const instances = installFakeXhr();
    const seen: number[] = [];
    const promise = uploadVideoMaster({
      signedUrl: 'u',
      file: new Blob(['x'.repeat(1000)]),
      contentType: 'video/mp4',
      onProgress: (p: VideoUploadProgress) => seen.push(p.percent),
    });
    const xhr = instances[0]!;
    const event = (loaded: number) =>
      xhr.upload.onprogress!({ lengthComputable: true, loaded, total: 1000 } as ProgressEvent);

    event(100); // 10%
    event(550); // 55%
    event(550); // duplicate — must NOT re-emit
    event(400); // transport re-reports SMALLER — must NOT rewind
    event(996); // 99.6% — floored AND held at 99, never rounded to 100
    xhr.status = 200;
    xhr.onload!(); // success settles to 100

    await promise;
    // Literal-pinned: any synthesised, rewound, or prematurely-rounded value
    // changes this exact sequence.
    expect(seen).toEqual([10, 55, 99, 100]);
  });

  it('NEVER reports 100 for a failed upload — the fraction stays where the transport stopped', async () => {
    const instances = installFakeXhr();
    const seen: number[] = [];
    const promise = uploadVideoMaster({
      signedUrl: 'u',
      file: new Blob(['x'.repeat(1000)]),
      contentType: 'video/mp4',
      onProgress: (p) => seen.push(p.percent),
    });
    const xhr = instances[0]!;
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 800, total: 1000 } as ProgressEvent);
    xhr.status = 500; // storage refused after 80% of bytes moved
    xhr.onload!();

    await expect(promise).resolves.toEqual({ ok: false, status: 500 });
    expect(seen).toEqual([80]);
    expect(seen).not.toContain(100);
  });

  it('reports nothing at all when the transport cannot size the body — no fabricated fraction', async () => {
    const instances = installFakeXhr();
    const seen: VideoUploadProgress[] = [];
    const promise = uploadVideoMaster({
      signedUrl: 'u',
      file: new Blob(['x']),
      contentType: 'video/mp4',
      onProgress: (p) => seen.push(p),
    });
    const xhr = instances[0]!;
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 10, total: 0 } as ProgressEvent);
    xhr.status = 200;
    xhr.onload!();
    await promise;

    // Only the genuine completion emit — no invented mid-flight numbers.
    expect(seen).toEqual([{ fraction: 1, percent: 100 }]);
  });
});
