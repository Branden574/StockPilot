import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_FORM_BODY_LIMIT, readJsonLimited } from './read-json-limited';

/**
 * Security invariant: a public form's body is measured before it is parsed.
 * readJsonLimited refuses a body over its limit by its declared length, or by
 * counting bytes as they arrive when no length is declared or the declared one
 * is wrong, and never parses a refused body.
 */

const URL = 'https://test.local/api/v1/public/form';

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    // A stream body needs half duplex in Node's fetch.
    duplex: 'half',
  } as RequestInit);
}

/** A body sent in chunks with no declared length, and how many chunks were read. */
function streamed(chunks: Uint8Array[]) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[pulled];
        pulled += 1;
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    // Nothing is pulled until a reader asks for it.
    { highWaterMark: 0 },
  );
  return {
    stream,
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('readJsonLimited', () => {
  it('is 256 KB for the public forms', () => {
    expect(PUBLIC_FORM_BODY_LIMIT).toBe(256 * 1024);
  });

  it('parses a JSON body within the limit', async () => {
    const res = await readJsonLimited(post(JSON.stringify({ name: 'Sam', lines: [1, 2] })), 1024);
    expect(res).toEqual({ ok: true, value: { name: 'Sam', lines: [1, 2] } });
  });

  it('takes a body of exactly the limit', async () => {
    const json = JSON.stringify({ pad: 'x'.repeat(100) });
    const res = await readJsonLimited(post(json), bytes(json).byteLength);
    expect(res.ok).toBe(true);
  });

  it('refuses a declared length over the limit without reading the body', async () => {
    const body = streamed([bytes('{"a":1}')]);
    const req = post(body.stream, { 'content-length': '2048' });
    const parse = vi.spyOn(JSON, 'parse');

    const res = await readJsonLimited(req, 1024);

    expect(res).toEqual({ ok: false, reason: 'too_large' });
    expect(req.bodyUsed).toBe(false);
    expect(body.pulled()).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('refuses a body with no declared length once its bytes pass the limit, and stops reading', async () => {
    const chunk = bytes('x'.repeat(400));
    const body = streamed([bytes('{"pad":"'), chunk, chunk, chunk, chunk, chunk, bytes('"}')]);
    const parse = vi.spyOn(JSON, 'parse');

    const res = await readJsonLimited(post(body.stream), 1024);

    expect(res).toEqual({ ok: false, reason: 'too_large' });
    expect(body.pulled()).toBeLessThan(7);
    expect(body.cancelled()).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('counts the bytes that arrive even when the declared length is smaller', async () => {
    const body = streamed([bytes(`{"pad":"${'x'.repeat(2000)}"}`)]);
    const res = await readJsonLimited(post(body.stream, { 'content-length': '10' }), 1024);
    expect(res).toEqual({ ok: false, reason: 'too_large' });
  });

  it('answers invalid_json for a body that is not JSON, or is empty', async () => {
    expect(await readJsonLimited(post('{not json'), 1024)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(await readJsonLimited(post(''), 1024)).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('decodes UTF-8 split across chunks', async () => {
    const all = bytes(JSON.stringify({ name: 'Zoë Ålund' }));
    const cut = all.indexOf(0xc3) + 1; // inside the two bytes of "ë"
    const body = streamed([all.slice(0, cut), all.slice(cut)]);
    expect(await readJsonLimited(post(body.stream), 1024)).toEqual({
      ok: true,
      value: { name: 'Zoë Ålund' },
    });
  });
});
