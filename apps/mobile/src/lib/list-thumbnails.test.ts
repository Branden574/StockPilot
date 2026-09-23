import { describe, expect, it } from 'vitest';

import { IdBatchReadError } from './id-batches';
import type { PhotoPaths } from './id-reads';
import { mergeResolvedThumbnails, resolveListThumbnails, type ThumbnailMap } from './list-thumbnails';

const photo = (path: string, thumb: string | null = null): PhotoPaths => ({
  storage_path: path,
  thumb_path: thumb,
});

describe('mergeResolvedThumbnails', () => {
  it('records a photoless item as null (resolved, no photo) and a signed one as its URL', () => {
    const next = mergeResolvedThumbnails(
      new Map(),
      ['a', 'b'],
      new Map([['a', photo('a.jpg')]]),
      new Map([['a.jpg', 'https://signed/a']]),
    );
    expect(next.get('a')).toBe('https://signed/a');
    expect(next.has('b')).toBe(true);
    expect(next.get('b')).toBeNull();
  });

  it('leaves a photo that failed to sign UNRESOLVED, never "no photo"', () => {
    const next = mergeResolvedThumbnails(new Map(), ['a'], new Map([['a', photo('a.jpg')]]), new Map());
    expect(next.has('a')).toBe(false);
  });

  it('returns the SAME object when nothing changes, so no re-render and no re-run', () => {
    const prev: ThumbnailMap = new Map([
      ['a', 'https://signed/a'],
      ['b', null],
    ]);
    expect(
      mergeResolvedThumbnails(prev, ['a', 'b'], new Map([['a', photo('a.jpg')]]), new Map([['a.jpg', 'https://signed/a']])),
    ).toBe(prev);
    // Only unsigned photos requested: nothing to record.
    expect(mergeResolvedThumbnails(prev, ['c'], new Map([['c', photo('c.jpg')]]), new Map())).toBe(prev);
  });

  it('never mutates prev', () => {
    const prev = new Map<string, string | null>();
    mergeResolvedThumbnails(prev, ['a'], new Map(), new Map());
    expect(prev.size).toBe(0);
  });
});

describe('resolveListThumbnails', () => {
  const sign = async (photos: PhotoPaths[]) =>
    new Map(photos.map((p) => [p.storage_path, `https://signed/${p.storage_path}`] as const));

  it('a failed photo read records NOTHING (never "no photo" for every id) and signs nothing', async () => {
    let signed = 0;
    const round = await resolveListThumbnails(
      ['a', 'b'],
      () => Promise.reject(new IdBatchReadError('URI too long', 414)),
      async (p) => {
        signed += 1;
        return sign(p);
      },
    );
    expect(round).toEqual({ ok: false, message: 'URI too long' });
    expect(signed).toBe(0);
  });

  it('a failed signing round records nothing either', async () => {
    const round = await resolveListThumbnails(
      ['a'],
      async () => new Map([['a', photo('a.jpg')]]),
      () => Promise.reject(new Error('storage down')),
    );
    expect(round).toEqual({ ok: false, message: 'storage down' });
  });

  it('after a successful round a photoless item is null and a photo is its URL', async () => {
    const round = await resolveListThumbnails(
      ['a', 'b'],
      async (ids) => {
        expect(ids).toEqual(['a', 'b']);
        return new Map([['a', photo('a.jpg', 'a-thumb.jpg')]]);
      },
      sign,
    );
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const next = round.value(new Map());
    expect(next.get('a')).toBe('https://signed/a.jpg');
    expect(next.get('b')).toBeNull();
  });

  it('does not call the signer when no requested item has a photo', async () => {
    let signed = 0;
    const round = await resolveListThumbnails(['a'], async () => new Map(), async (p) => {
      signed += 1;
      return sign(p);
    });
    expect(signed).toBe(0);
    expect(round.ok && round.value(new Map()).get('a')).toBeNull();
  });
});
