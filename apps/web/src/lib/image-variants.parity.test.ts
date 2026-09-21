/**
 * PARITY GUARD: the upload worker and the main-thread fallback make the SAME files.
 *
 * WHY THIS FILE EXISTS
 *
 * A photo uploaded on the web becomes a master, a thumbnail and a blur
 * placeholder. Two pieces of code can do that work: `image-variants.worker.ts`
 * (what every modern browser runs) and the fallback inside `image-variants.ts`.
 * Each had its own copy of the sizes. On 2026-07-01 the fallback's thumbnail
 * was raised to 400 px and the worker's was not, so the change reached nobody,
 * and nothing failed for eleven weeks because both paths "work".
 *
 * The sizes now live once, in `image-variants.config.ts`. This file keeps it
 * that way, in three arms:
 *
 *   ARM 1  runs BOTH paths against recording fakes of the canvas and compares
 *          what each one asked the canvas for with LITERAL expectations. (An
 *          assertion of the form `worker === fallback` alone would pass for two
 *          paths that are wrong together.)
 *   ARM 2  the rules around the encode: keep the original when WebP is larger,
 *          drop an oversize placeholder, fall back when the worker fails.
 *   ARM 3  reads the SOURCE: neither path may carry a number of its own, both
 *          must import the shared module, the `new Worker(new URL(…))`
 *          expression must keep the exact shape the bundler recognises, and the
 *          two backfill tools must agree with the shared thumbnail size.
 *
 * MUTATION-PROVEN. A guard that cannot fail is not a guard, so four mutations
 * were run against this file and image-variants.config.test.ts before they
 * shipped (43 tests in all); each was reverted after:
 *   1. `thumb.maxDimension` 200 -> 400 in the config -> 14 failures: the literal
 *      pin, 8 of the 10 ARM 1 rows (the two 150 x 100 rows cannot move: nothing
 *      is enlarged), the "never larger than 200 px" check, the three
 *      worker-failure fallbacks, and the backfill agreement.
 *   2. A private `const THUMB_DIMENSION = 400;` put back into the worker and
 *      used for the thumb -> 6 failures: the four worker rows and the 200 px
 *      check, while every fallback row stays green (the guard discriminates),
 *      and ARM 3 names the number.
 *   3. The worker's import swapped for an inline copy of the constants that
 *      still AGREES -> ARM 1 and ARM 2 stay green, ARM 3 fails twice. That is
 *      the fork this file exists to catch on the day it is made, not the day it
 *      diverges.
 *   4. The worker URL hoisted into a variable -> only the Worker-expression
 *      test fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_VARIANTS } from './image-variants.config';

// ─────────────────────────────────────────────────────────────────────────────
// Recording fakes
// ─────────────────────────────────────────────────────────────────────────────

interface CanvasRequest {
  w: number;
  h: number;
  type: string | undefined;
  quality: number | undefined;
}

interface Scenario {
  source: { width: number; height: number };
  /** Encoded size the fake canvas answers with, per variant. */
  bytes?: { master?: number; thumb?: number; lqip?: number };
}

const QUALITY_TO_VARIANT: Record<string, 'master' | 'thumb' | 'lqip'> = {
  '0.85': 'master',
  '0.8': 'thumb',
  '0.5': 'lqip',
};

function makeRecorder(scenario: Scenario) {
  const requests: CanvasRequest[] = [];
  const close = vi.fn();
  const encoded = (req: CanvasRequest): Blob => {
    const variant = QUALITY_TO_VARIANT[String(req.quality)] ?? 'master';
    const size = scenario.bytes?.[variant] ?? 12;
    return new Blob([new Uint8Array(size)], { type: req.type });
  };
  const createImageBitmap = vi.fn(async () => ({ ...scenario.source, close }));
  return { requests, close, encoded, createImageBitmap };
}

function sourceFile(bytes = 1000, name = 'IMG_0001.JPG'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg', lastModified: 1_700_000 });
}

type WorkerReply =
  | { ok: true; master: File; thumbBlob: Blob | null; lqip: string | null }
  | { ok: false; message: string };

/** Loads the REAL worker module and calls the handler it installs on `self`. */
async function runWorkerPath(scenario: Scenario, file = sourceFile()) {
  const rec = makeRecorder(scenario);
  const posted: WorkerReply[] = [];
  const fakeSelf: {
    onmessage: ((e: { data: { file: File } }) => Promise<void>) | null;
    postMessage: (m: WorkerReply) => void;
    btoa: typeof btoa;
  } = { onmessage: null, postMessage: (m) => posted.push(m), btoa: globalThis.btoa };

  class FakeOffscreenCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {}
    getContext() {
      return { drawImage: () => undefined };
    }
    async convertToBlob(opts: { type?: string; quality?: number }) {
      const req = { w: this.width, h: this.height, type: opts.type, quality: opts.quality };
      rec.requests.push(req);
      return rec.encoded(req);
    }
  }

  vi.resetModules();
  vi.stubGlobal('self', fakeSelf);
  vi.stubGlobal('createImageBitmap', rec.createImageBitmap);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  await import('./image-variants.worker');
  if (!fakeSelf.onmessage) throw new Error('the worker module did not install self.onmessage');
  await fakeSelf.onmessage({ data: { file } });
  return { ...rec, reply: posted[0] };
}

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.();
    });
  }
}

/** Loads the REAL main-thread module. `WorkerClass` undefined means "this browser has no Worker". */
async function runMainThreadPath(
  scenario: Scenario,
  file = sourceFile(),
  WorkerClass?: new (...args: unknown[]) => unknown,
) {
  const rec = makeRecorder(scenario);
  const fakeDocument = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number) {
          const req = { w: this.width, h: this.height, type, quality };
          rec.requests.push(req);
          cb(rec.encoded(req));
        },
      };
    },
  };

  vi.resetModules();
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('FileReader', FakeFileReader);
  vi.stubGlobal('createImageBitmap', rec.createImageBitmap);
  vi.stubGlobal('Worker', WorkerClass);
  // canUseWorker() also wants OffscreenCanvas. Present only when a Worker is.
  vi.stubGlobal('OffscreenCanvas', WorkerClass ? class {} : undefined);
  const { compressImageVariants } = await import('./image-variants');
  const result = await compressImageVariants(file);
  return { ...rec, result };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// ─────────────────────────────────────────────────────────────────────────────
// ARM 1: both paths ask the canvas for the same three files
// ─────────────────────────────────────────────────────────────────────────────

const MIME = 'image/webp';

/** LITERALS, written out by hand. Do not compute these from the config. */
const TABLE: Array<{ name: string; source: [number, number]; expected: CanvasRequest[] }> = [
  {
    name: 'phone landscape 4032 x 3024',
    source: [4032, 3024],
    expected: [
      { w: 2048, h: 1536, type: MIME, quality: 0.85 },
      { w: 200, h: 150, type: MIME, quality: 0.8 },
      { w: 16, h: 12, type: MIME, quality: 0.5 },
    ],
  },
  {
    name: 'phone portrait 3024 x 4032',
    source: [3024, 4032],
    expected: [
      { w: 1536, h: 2048, type: MIME, quality: 0.85 },
      { w: 150, h: 200, type: MIME, quality: 0.8 },
      { w: 12, h: 16, type: MIME, quality: 0.5 },
    ],
  },
  {
    name: '16:9 over the cap 5000 x 2813',
    source: [5000, 2813],
    expected: [
      { w: 2048, h: 1152, type: MIME, quality: 0.85 },
      { w: 200, h: 113, type: MIME, quality: 0.8 },
      { w: 16, h: 9, type: MIME, quality: 0.5 },
    ],
  },
  {
    name: 'square under the cap 1000 x 1000 (master is not enlarged)',
    source: [1000, 1000],
    expected: [
      { w: 1000, h: 1000, type: MIME, quality: 0.85 },
      { w: 200, h: 200, type: MIME, quality: 0.8 },
      { w: 16, h: 16, type: MIME, quality: 0.5 },
    ],
  },
  {
    name: 'smaller than a thumbnail 150 x 100 (nothing is enlarged)',
    source: [150, 100],
    expected: [
      { w: 150, h: 100, type: MIME, quality: 0.85 },
      { w: 150, h: 100, type: MIME, quality: 0.8 },
      { w: 16, h: 11, type: MIME, quality: 0.5 },
    ],
  },
];

describe('ARM 1: the worker and the fallback request identical variants', () => {
  it.each(TABLE)('worker: $name', async ({ source, expected }) => {
    const run = await runWorkerPath({ source: { width: source[0], height: source[1] } });
    expect(run.requests).toEqual(expected);
    expect(run.reply).toMatchObject({ ok: true });
  });

  it.each(TABLE)('fallback: $name', async ({ source, expected }) => {
    const run = await runMainThreadPath({ source: { width: source[0], height: source[1] } });
    expect(run.requests).toEqual(expected);
  });

  it('no thumbnail request is larger than 200 px on either path', async () => {
    for (const { source } of TABLE) {
      const scenario = { source: { width: source[0], height: source[1] } };
      for (const run of [await runWorkerPath(scenario), await runMainThreadPath(scenario)]) {
        const thumb = run.requests[1]!;
        expect(Math.max(thumb.w, thumb.h)).toBeLessThanOrEqual(200);
      }
    }
  });

  it('both paths release the decoded bitmap exactly once', async () => {
    const scenario = { source: { width: 4032, height: 3024 } };
    expect((await runWorkerPath(scenario)).close).toHaveBeenCalledTimes(1);
    expect((await runMainThreadPath(scenario)).close).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARM 2: the rules around the encode
// ─────────────────────────────────────────────────────────────────────────────

describe('ARM 2: the same rules on both paths', () => {
  const source = { width: 4032, height: 3024 };

  it('a smaller WebP master replaces the original, renamed .webp, keeping lastModified', async () => {
    const file = sourceFile(1000, 'IMG_0001.JPG');
    const worker = await runWorkerPath({ source, bytes: { master: 500 } }, file);
    const fallback = await runMainThreadPath({ source, bytes: { master: 500 } }, file);
    const masters = [(worker.reply as { master: File }).master, fallback.result.master];
    for (const master of masters) {
      expect(master).not.toBe(file);
      expect(master.name).toBe('IMG_0001.webp');
      expect(master.type).toBe('image/webp');
      expect(master.size).toBe(500);
      expect(master.lastModified).toBe(1_700_000);
    }
  });

  it('a WebP master that is NOT smaller is discarded and the original file is kept', async () => {
    const file = sourceFile(1000);
    for (const size of [1000, 5000]) {
      const worker = await runWorkerPath({ source, bytes: { master: size } }, file);
      const fallback = await runMainThreadPath({ source, bytes: { master: size } }, file);
      expect((worker.reply as { master: File }).master).toBe(file);
      expect(fallback.result.master).toBe(file);
    }
  });

  it('a placeholder of 1999 characters is kept and one of 2003 is dropped, on both paths', async () => {
    // "data:image/webp;base64," is 23 characters; 1482 bytes encode to 1976, 1483 to 1980.
    for (const [bytes, kept] of [
      [1482, true],
      [1483, false],
    ] as const) {
      const worker = await runWorkerPath({ source, bytes: { lqip: bytes } });
      const fallback = await runMainThreadPath({ source, bytes: { lqip: bytes } });
      const lqips = [(worker.reply as { lqip: string | null }).lqip, fallback.result.lqip];
      for (const lqip of lqips) {
        if (kept) {
          expect(lqip).toHaveLength(1999);
          expect(lqip?.startsWith('data:image/webp;base64,')).toBe(true);
        } else {
          expect(lqip).toBeNull();
        }
      }
    }
  });

  it('both paths produce the same placeholder text for the same bytes', async () => {
    const worker = await runWorkerPath({ source, bytes: { lqip: 40 } });
    const fallback = await runMainThreadPath({ source, bytes: { lqip: 40 } });
    expect((worker.reply as { lqip: string }).lqip).toBe(fallback.result.lqip);
  });

  it('an undecodable file: the worker reports failure, the fallback uploads the original untouched', async () => {
    const file = sourceFile();
    const scenario = { source };
    const worker = await runWorkerPath(scenario, file).catch(() => null);
    expect(worker).not.toBeNull();

    // Same modules, but the decode throws.
    vi.unstubAllGlobals();
    vi.resetModules();
    const posted: WorkerReply[] = [];
    const fakeSelf = {
      onmessage: null as ((e: { data: { file: File } }) => Promise<void>) | null,
      postMessage: (m: WorkerReply) => posted.push(m),
      btoa: globalThis.btoa,
    };
    vi.stubGlobal('self', fakeSelf);
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('The source image could not be decoded.');
    });
    await import('./image-variants.worker');
    await fakeSelf.onmessage!({ data: { file } });
    expect(posted[0]).toEqual({ ok: false, message: 'The source image could not be decoded.' });

    vi.unstubAllGlobals();
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', undefined);
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('The source image could not be decoded.');
    });
    const { compressImageVariants } = await import('./image-variants');
    expect(await compressImageVariants(file)).toEqual({
      master: file,
      thumbBlob: null,
      lqip: null,
    });
  });
});

describe('ARM 2: when the worker cannot do the job, the fallback does the SAME job', () => {
  const scenario = { source: { width: 4032, height: 3024 } };
  const expected = TABLE[0]!.expected;

  it('the Worker constructor throws (blocked worker URL, strict CSP)', async () => {
    class ThrowingWorker {
      constructor() {
        throw new Error('SecurityError');
      }
    }
    const run = await runMainThreadPath(scenario, sourceFile(), ThrowingWorker);
    expect(run.requests).toEqual(expected);
  });

  it('the worker answers ok: false', async () => {
    class RefusingWorker {
      onmessage: ((e: { data: WorkerReply }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = vi.fn();
      postMessage() {
        queueMicrotask(() => this.onmessage?.({ data: { ok: false, message: 'decode-failed' } }));
      }
    }
    const run = await runMainThreadPath(scenario, sourceFile(), RefusingWorker);
    expect(run.requests).toEqual(expected);
  });

  it('the worker script fails to load (onerror): a broken worker chunk must not block uploads', async () => {
    class BrokenWorker {
      onmessage: ((e: { data: WorkerReply }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = vi.fn();
      postMessage() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    const run = await runMainThreadPath(scenario, sourceFile(), BrokenWorker);
    expect(run.requests).toEqual(expected);
  });

  it('a worker that succeeds is believed, terminated, and the main thread encodes nothing', async () => {
    const file = sourceFile();
    const thumbBlob = new Blob([new Uint8Array(7)], { type: MIME });
    const terminate = vi.fn();
    const seen: { url?: string; options?: unknown; message?: unknown } = {};
    class WorkingWorker {
      onmessage: ((e: { data: WorkerReply }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = terminate;
      constructor(url: URL, options: unknown) {
        seen.url = String(url);
        seen.options = options;
      }
      postMessage(message: unknown) {
        seen.message = message;
        queueMicrotask(() =>
          this.onmessage?.({ data: { ok: true, master: file, thumbBlob, lqip: 'data:x' } }),
        );
      }
    }
    const run = await runMainThreadPath(
      scenario,
      file,
      WorkingWorker as unknown as new (...args: unknown[]) => unknown,
    );
    expect(run.result).toEqual({ master: file, thumbBlob, lqip: 'data:x' });
    expect(run.requests).toEqual([]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(seen.url).toMatch(/image-variants\.worker\.ts$/);
    expect(seen.options).toEqual({ type: 'module' });
    expect(seen.message).toEqual({ file });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARM 3: the source
// ─────────────────────────────────────────────────────────────────────────────

const LIB = path.resolve(__dirname);
const WEB = path.resolve(__dirname, '..', '..');
const read = (file: string) => readFileSync(file, 'utf8');

/** Code only: comments, strings, template literals and regex literals removed. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/\/(?![*/\s])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*/g, ' ');
}

/** Every numeric literal other than 0 and 1 (loop counters and indexes). */
function ownNumbers(source: string): string[] {
  return (codeOnly(source).match(/(?<![\w$.])\d+(?:\.\d+)?(?![\w$])/g) ?? []).filter(
    (n) => n !== '0' && n !== '1',
  );
}

describe('ARM 3: DRIFT GUARD on the source', () => {
  const FILES = ['image-variants.ts', 'image-variants.worker.ts'];

  it('the detector can fail: it sees a private constant, and ignores comments and strings', () => {
    expect(ownNumbers('const THUMB_DIMENSION = 400;\nconst q = 0.8;')).toEqual(['400', '0.8']);
    expect(
      ownNumbers("// was 200, now 400\nconst s = 'w=640'; for (let i = 0; i < n; i++) {}"),
    ).toEqual([]);
    expect(ownNumbers('/* Safari 16.4 */ const re = /\\d{3}/; x[0]!')).toEqual([]);
  });

  it.each(FILES)('%s carries no size or quality of its own', (file) => {
    expect(
      ownNumbers(read(path.join(LIB, file))),
      `${file} has a numeric literal of its own. Sizes and qualities belong in ` +
        'image-variants.config.ts, which the OTHER upload path imports too; a private copy is how ' +
        'the worker stayed at 200 px for eleven weeks after the fallback was raised to 400.',
    ).toEqual([]);
  });

  it.each(FILES)('%s imports the shared module by its relative path', (file) => {
    expect(read(path.join(LIB, file))).toMatch(
      /import \{[^}]*\bIMAGE_VARIANTS\b[^}]*\} from '\.\/image-variants\.config';/,
    );
  });

  it('the shared module is inert: no imports, no DOM, no worker globals', () => {
    const code = codeOnly(read(path.join(LIB, 'image-variants.config.ts')));
    expect(code).not.toMatch(/\bimport\b|\brequire\b/);
    expect(code).not.toMatch(/\b(window|document|self|globalThis|navigator)\b/);
  });

  it('the Worker is created with the exact expression the bundler recognises', () => {
    // `new Worker(new URL('<literal>', import.meta.url), …)` is what makes the
    // bundler BUILD the worker and its imports. Hoist the URL into a variable
    // and it ships the raw .ts file instead, whose import cannot resolve; the
    // upload then silently runs on the main thread for everyone.
    expect(read(path.join(LIB, 'image-variants.ts'))).toMatch(
      /new Worker\(\s*new URL\('\.\/image-variants\.worker\.ts', import\.meta\.url\),\s*\{\s*type: 'module',?\s*\},?\s*\)/,
    );
  });

  it('both backfill tools make thumbnails of the shared size', () => {
    const tools = [
      path.join(WEB, 'scripts', 'backfill-item-thumbs.mjs'),
      path.join(WEB, 'src', 'app', 'api', 'admin', 'backfill-item-thumbs', 'route.ts'),
    ];
    for (const tool of tools) {
      const match = /\bconst THUMB_SIZE = (\d+);/.exec(read(tool));
      expect(match, `${tool}: THUMB_SIZE declaration not found (was it renamed?)`).not.toBeNull();
      expect(Number(match![1]), `${tool} disagrees with image-variants.config.ts`).toBe(
        IMAGE_VARIANTS.thumb.maxDimension,
      );
    }
  });
});
