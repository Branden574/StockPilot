import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { classifyImageUrl } from './image-class';

const ORIGIN = 'https://stockpilotusa.com';
const STORAGE = 'https://xyzcompany.supabase.co/storage/v1';
const OBJECT = 'item-images/1111/items/2222/3333';
// Deliberately NOT JWT-shaped: a secret scanner would flag a lookalike on every PR.
const TOKEN = 'FAKE-SIGNING-TOKEN-0000';

describe('classifyImageUrl', () => {
  it('recognises a pre-generated thumbnail served straight from Storage', () => {
    expect(
      classifyImageUrl(`${STORAGE}/object/sign/${OBJECT}-thumb.webp?token=${TOKEN}`, ORIGIN),
    ).toEqual({
      delivery: 'storage-signed',
      upstream: null,
      variant: 'thumb',
      requestedWidth: null,
      requestedQuality: null,
      signed: true,
    });
  });

  it('recognises a master pulled through the optimizer, with the width and quality asked for', () => {
    const inner = encodeURIComponent(`${STORAGE}/object/sign/${OBJECT}.jpg?token=${TOKEN}`);
    expect(classifyImageUrl(`/_next/image?url=${inner}&w=384&q=75`, ORIGIN)).toEqual({
      delivery: 'optimizer',
      upstream: 'storage-signed',
      variant: 'master',
      requestedWidth: 384,
      requestedQuality: 75,
      signed: true,
    });
  });

  it('flags the on-demand Storage transform, the pattern the repo reverted', () => {
    const out = classifyImageUrl(
      `${STORAGE}/render/image/sign/${OBJECT}.jpg?token=${TOKEN}&width=200`,
      ORIGIN,
    );
    expect(out.delivery).toBe('storage-transform');
    expect(out.variant).toBe('master');
  });

  it('tells an external book cover from a same-origin asset', () => {
    expect(classifyImageUrl('https://books.google.com/books/content?id=abc', ORIGIN).delivery).toBe(
      'external',
    );
    expect(classifyImageUrl('/brand/logo.png', ORIGIN).delivery).toBe('same-origin');
    const viaOptimizer = classifyImageUrl(
      `/_next/image?url=${encodeURIComponent('https://covers.openlibrary.org/b/id/1-M.jpg')}&w=64&q=75`,
      ORIGIN,
    );
    expect(viaOptimizer).toMatchObject({
      delivery: 'optimizer',
      upstream: 'external',
      variant: 'not-an-item-photo',
      signed: false,
    });
  });

  it('treats inline placeholders as inline', () => {
    expect(classifyImageUrl('data:image/webp;base64,AAAA', ORIGIN).delivery).toBe('inline');
    expect(classifyImageUrl('blob:https://stockpilotusa.com/1', ORIGIN).delivery).toBe('inline');
  });

  it('never throws and never guesses on rubbish', () => {
    expect(classifyImageUrl('', ORIGIN).delivery).toBe('unknown');
    expect(classifyImageUrl('http://[', ORIGIN).delivery).toBe('unknown');
    expect(classifyImageUrl('/_next/image?w=64', ORIGIN)).toMatchObject({
      delivery: 'optimizer',
      requestedWidth: 64,
    });
  });

  it('returns a class that contains no part of the URL: no token, no path, no host', () => {
    const inner = encodeURIComponent(`${STORAGE}/object/sign/${OBJECT}-thumb.webp?token=${TOKEN}`);
    for (const url of [
      `${STORAGE}/object/sign/${OBJECT}.jpg?token=${TOKEN}`,
      `/_next/image?url=${inner}&w=64&q=75`,
    ]) {
      const serialized = JSON.stringify(classifyImageUrl(url, ORIGIN));
      for (const secret of [TOKEN, 'FAKE-SIGNING', '1111', '2222', '3333', 'xyzcompany'])
        expect(serialized).not.toContain(secret);
    }
  });

  it('is self-contained, because the harness injects its source text into the page', () => {
    // Re-evaluate the function's OWN source text (nothing external is
    // interpolated) in an empty V8 context that holds only `URL`. If the
    // function ever closes over a module binding or a transpiler helper, it
    // throws a ReferenceError here instead of silently breaking inside the browser.
    const rebuilt = runInNewContext(`(${classifyImageUrl.toString()})`, {
      URL,
    }) as typeof classifyImageUrl;
    expect(
      rebuilt(`${STORAGE}/object/sign/${OBJECT}-thumb.webp?token=${TOKEN}`, ORIGIN).variant,
    ).toBe('thumb');
    expect(rebuilt('data:image/png;base64,AA', ORIGIN).delivery).toBe('inline');
    expect(
      rebuilt(
        `/_next/image?url=${encodeURIComponent(`${STORAGE}/object/sign/${OBJECT}.jpg`)}&w=64&q=75`,
        ORIGIN,
      ).upstream,
    ).toBe('storage-signed');
  });
});
