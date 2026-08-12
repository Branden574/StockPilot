import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { PoImportsService } from '@/server/services/po-imports';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/server/services/po-imports', () => ({ PoImportsService: vi.fn() }));

/**
 * The scan route's NAMING contract (mig 0333): a `displayNames` field holding a
 * JSON array with ONE ENTRY PER IMPORT, index-aligned with the `file` parts.
 *
 * The failure this file exists to catch is the index mismatch — file 2 created
 * under file 3's name — which is silent, permanent, and indistinguishable from
 * a user's own typo once it has happened. Every separate-mode assertion pairs a
 * literal filename with a literal name, and the length rule is asserted as a
 * hard 400 rather than a pad/truncate.
 *
 * The first assertion below is why this is a JSON array and not repeated
 * `displayName` parts: an EMPTY multipart part does not reliably survive a
 * round trip (this very test environment's parser drops it), so "file 2 has no
 * name" has to travel as an explicit `null`.
 */

const ctx = {
  organizationId: 'org-1',
  userId: 'u-1',
  role: 'admin' as const,
  supabase: {} as never,
  mfaRequired: false,
  mfaSatisfied: true,
  enabledModules: new Set<ModuleId>(),
};

function pdf(name: string): File {
  return new File([new Uint8Array(16)], name, { type: 'application/pdf' });
}

/** `names` is sent verbatim as the JSON `displayNames` field when provided. */
function scanRequest(
  files: File[],
  opts: { mode?: string; names?: Array<string | null>; rawNames?: string } = {},
): Request {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  if (opts.mode) fd.append('mode', opts.mode);
  if (opts.rawNames !== undefined) fd.append('displayNames', opts.rawNames);
  else if (opts.names) fd.append('displayNames', JSON.stringify(opts.names));
  return new Request('https://test.local/api/po-imports/scan', { method: 'POST', body: fd });
}

let createFromScan: ReturnType<typeof vi.fn>;

/** Every call's (first filename, displayName) pair, in call order. */
function pairs(): Array<[string, string | null | undefined]> {
  return createFromScan.mock.calls.map((c) => {
    const arg = c[0] as {
      files: Array<{ fileName: string }>;
      displayName?: string | null;
    };
    return [arg.files[0]!.fileName, arg.displayName];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
  let n = 0;
  createFromScan = vi.fn(async () => ({
    id: `imp-${(n += 1)}`,
    duplicateOf: null,
    lowConfidenceLines: 0,
  }));
  vi.mocked(PoImportsService).mockImplementation(() => ({ createFromScan }) as never);
});

describe('the transport hazard this contract is shaped around', () => {
  it('an EMPTY repeated form part does not survive the multipart round trip', async () => {
    // Documented evidence for the design note in route.ts: the middle value is
    // appended and then simply is not there on the other side. Any scheme that
    // encoded "no name" as an empty part would therefore slide every later
    // name onto the wrong file.
    const fd = new FormData();
    fd.append('displayName', 'First');
    fd.append('displayName', '');
    fd.append('displayName', 'Third');
    expect(fd.getAll('displayName')).toEqual(['First', '', 'Third']);

    const roundTripped = await new Request('https://test.local/x', {
      method: 'POST',
      body: fd,
    }).formData();
    expect(roundTripped.getAll('displayName')).toEqual(['First', 'Third']);
  });

  it('a JSON array carries null through the same round trip intact', async () => {
    const fd = new FormData();
    fd.append('displayNames', JSON.stringify(['First', null, 'Third']));
    const roundTripped = await new Request('https://test.local/x', {
      method: 'POST',
      body: fd,
    }).formData();
    expect(JSON.parse(String(roundTripped.get('displayNames')))).toEqual([
      'First',
      null,
      'Third',
    ]);
  });
});

describe('POST /api/po-imports/scan — separate mode pairs name[i] with file[i]', () => {
  it('file N gets name N, in order', async () => {
    const res = await POST(
      scanRequest([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], {
        mode: 'separate',
        names: ['August DC4 Book Order', 'September Follett Restock', 'Uniform reorder'],
      }),
    );
    expect(res.status).toBe(200);
    expect(pairs()).toEqual([
      ['a.pdf', 'August DC4 Book Order'],
      ['b.pdf', 'September Follett Restock'],
      ['c.pdf', 'Uniform reorder'],
    ]);
  });

  it('a NULL in the middle keeps the rest aligned (name 3 does not slide onto file 2)', async () => {
    await POST(
      scanRequest([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], {
        mode: 'separate',
        names: ['First', null, 'Third'],
      }),
    );
    expect(pairs()).toEqual([
      ['a.pdf', 'First'],
      ['b.pdf', null],
      ['c.pdf', 'Third'],
    ]);
  });

  it('a blank STRING in the middle behaves like null and keeps alignment', async () => {
    await POST(
      scanRequest([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], {
        mode: 'separate',
        names: ['First', '   ', 'Third'],
      }),
    );
    expect(pairs()).toEqual([
      ['a.pdf', 'First'],
      ['b.pdf', null],
      ['c.pdf', 'Third'],
    ]);
  });

  it('REFUSES fewer names than files rather than leaving the tail to guesswork', async () => {
    const res = await POST(
      scanRequest([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], {
        mode: 'separate',
        names: ['Only the first'],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'displayNames must have exactly 3 entries — one per import — but got 1.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('REFUSES more names than files', async () => {
    const res = await POST(
      scanRequest([pdf('a.pdf'), pdf('b.pdf')], {
        mode: 'separate',
        names: ['First', 'Second', 'Third has no file'],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'displayNames must have exactly 2 entries — one per import — but got 3.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });
});

describe('POST /api/po-imports/scan — combined mode is ONE import with ONE name', () => {
  it('3 files merged as pages of one PO produce a single createFromScan carrying that name', async () => {
    const res = await POST(
      scanRequest([pdf('page1.pdf'), pdf('page2.pdf'), pdf('page3.pdf')], {
        mode: 'combined',
        names: ['August DC4 Book Order'],
      }),
    );
    expect(res.status).toBe(200);
    expect(createFromScan).toHaveBeenCalledTimes(1);
    const arg = createFromScan.mock.calls[0]![0] as {
      files: Array<{ fileName: string }>;
      displayName: string | null;
    };
    expect(arg.files.map((f) => f.fileName)).toEqual(['page1.pdf', 'page2.pdf', 'page3.pdf']);
    expect(arg.displayName).toBe('August DC4 Book Order');
  });

  it('REFUSES a per-file array in combined mode — one import takes one name', async () => {
    const res = await POST(
      scanRequest([pdf('page1.pdf'), pdf('page2.pdf')], {
        mode: 'combined',
        names: ['One', 'Two'],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'displayNames must have exactly 1 entry — one per import — but got 2.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('a single file is always combined and takes the one name', async () => {
    await POST(scanRequest([pdf('image.jpg')], { names: ['August DC4 Book Order'] }));
    expect(pairs()).toEqual([['image.jpg', 'August DC4 Book Order']]);
  });

  it("mode='separate' with only ONE file falls back to combined and still takes one name", async () => {
    await POST(
      scanRequest([pdf('image.jpg')], { mode: 'separate', names: ['August DC4 Book Order'] }),
    );
    expect(pairs()).toEqual([['image.jpg', 'August DC4 Book Order']]);
  });
});

describe('POST /api/po-imports/scan — old clients and rejected names', () => {
  it('OLD CLIENT: a request with NO displayNames field at all still succeeds', async () => {
    const res = await POST(scanRequest([pdf('image.jpg')]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: 'imp-1' });
    expect(pairs()).toEqual([['image.jpg', null]]);
  });

  it('OLD CLIENT: separate mode with no names creates every import unnamed', async () => {
    await POST(scanRequest([pdf('a.pdf'), pdf('b.pdf')], { mode: 'separate' }));
    expect(pairs()).toEqual([
      ['a.pdf', null],
      ['b.pdf', null],
    ]);
  });

  it('a present-but-blank displayNames field is treated as omitted', async () => {
    const res = await POST(scanRequest([pdf('image.jpg')], { rawNames: '' }));
    expect(res.status).toBe(200);
    expect(pairs()).toEqual([['image.jpg', null]]);
  });

  it('REFUSES malformed JSON', async () => {
    const res = await POST(scanRequest([pdf('a.pdf')], { rawNames: 'not json' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'displayNames must be a JSON array of names.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('REFUSES a JSON object (not an array)', async () => {
    const res = await POST(scanRequest([pdf('a.pdf')], { rawNames: '{"0":"nope"}' }));
    expect(res.status).toBe(400);
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('REFUSES a non-string, non-null entry', async () => {
    const res = await POST(scanRequest([pdf('a.pdf')], { rawNames: '[42]' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'Each displayNames entry must be a string or null.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('REFUSES an oversized field before it is even parsed', async () => {
    const res = await POST(scanRequest([pdf('a.pdf')], { rawNames: 'x'.repeat(4097) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'displayNames is too large.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('REFUSES an oversized name with 400 and never calls the service', async () => {
    const res = await POST(scanRequest([pdf('a.pdf')], { names: ['x'.repeat(161)] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'Name is too long (160 characters max).',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('REFUSES a bidi-override name with 400 and never calls the service', async () => {
    // U+202E built by codepoint — a raw one here would visually reverse this
    // line in a diff viewer, which is the whole reason the rule exists.
    const spoof = `August${String.fromCodePoint(0x202e)}DC4`;
    const res = await POST(scanRequest([pdf('a.pdf')], { names: [spoof] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'validation_error',
      message: 'Remove control and text-direction characters from the name.',
    });
    expect(createFromScan).not.toHaveBeenCalled();
  });

  it('a bad name on file 3 of 3 is refused BEFORE any of the three imports is created', async () => {
    const res = await POST(
      scanRequest([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], {
        mode: 'separate',
        names: ['ok', 'also ok', 'x'.repeat(161)],
      }),
    );
    expect(res.status).toBe(400);
    expect(createFromScan).not.toHaveBeenCalled();
  });
});
