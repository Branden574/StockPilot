import { describe, expect, it, vi } from 'vitest';

import {
  STORED_FILE_LINK_SECONDS,
  linkIsFresh,
  linkToOpen,
  signerFor,
  type StorageSigner,
} from './stored-file-link';

/**
 * A stored file's signed link (an order's proof of delivery, a purchase
 * order's attachment) lasts an hour, and a screen can stay open longer. A tap
 * opens the link the list signed while it has more than five minutes left,
 * and signs the file again otherwise. Before, the tap opened whatever link
 * the list held, expired or not.
 */

const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);
const MIN = 60_000;

function signer(result: string | null | Error) {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

describe('linkIsFresh', () => {
  it('a link is fresh until five minutes before its hour is up', () => {
    const link = { url: 'https://files.example/a?x=1', signedAt: T0 };
    expect(STORED_FILE_LINK_SECONDS).toBe(3600);
    expect(linkIsFresh(link, T0)).toBe(true);
    expect(linkIsFresh(link, T0 + 54 * MIN)).toBe(true);
    expect(linkIsFresh(link, T0 + 55 * MIN)).toBe(false);
    expect(linkIsFresh(link, T0 + 61 * MIN)).toBe(false);
  });

  it('no link, or a link with no signing time, is never fresh', () => {
    expect(linkIsFresh({ url: null, signedAt: T0 }, T0)).toBe(false);
    expect(linkIsFresh({ url: 'https://files.example/a', signedAt: null }, T0)).toBe(false);
  });
});

describe('linkToOpen', () => {
  it('a fresh link opens as it is, with no signing request', async () => {
    const sign = signer('https://files.example/new');
    const link = await linkToOpen(
      { url: 'https://files.example/old', signedAt: T0 },
      sign,
      () => T0 + 10 * MIN,
    );
    expect(link).toEqual({ url: 'https://files.example/old', signedAt: T0, resigned: false });
    expect(sign).not.toHaveBeenCalled();
  });

  // Mutation caught: opening the held link whatever its age (the defect).
  it('a link past its hour, or about to be, is signed again and the new one opens', async () => {
    for (const age of [55 * MIN, 61 * MIN, 5 * 60 * MIN]) {
      const sign = signer('https://files.example/new');
      const now = T0 + age;
      const link = await linkToOpen(
        { url: 'https://files.example/old', signedAt: T0 },
        sign,
        () => now,
      );
      expect(link, String(age)).toEqual({
        url: 'https://files.example/new',
        signedAt: now,
        resigned: true,
      });
      expect(sign).toHaveBeenCalledTimes(1);
    }
  });

  it('no link yet (the list could not sign it) is signed at the tap', async () => {
    const sign = signer('https://files.example/new');
    expect(await linkToOpen({ url: null, signedAt: null }, sign, () => T0)).toEqual({
      url: 'https://files.example/new',
      signedAt: T0,
      resigned: true,
    });
  });

  it('the new link is timed from before the request, never after it', async () => {
    let clock = T0 + 2 * 60 * MIN;
    const sign = vi.fn(async () => {
      clock += 30_000; // the request takes 30 s
      return 'https://files.example/new';
    });
    const link = await linkToOpen(
      { url: 'https://files.example/old', signedAt: T0 },
      sign,
      () => clock,
    );
    expect(link?.signedAt).toBe(T0 + 2 * 60 * MIN);
  });

  it('null when the link is stale and signing fails or throws', async () => {
    const stale = { url: 'https://files.example/old', signedAt: T0 };
    expect(await linkToOpen(stale, signer(null), () => T0 + 2 * 60 * MIN)).toBeNull();
    expect(
      await linkToOpen(stale, signer(new Error('offline')), () => T0 + 2 * 60 * MIN),
    ).toBeNull();
    expect(await linkToOpen({ url: null, signedAt: null }, signer(null), () => T0)).toBeNull();
  });
});

describe('signerFor', () => {
  function storage(answer: { data: { signedUrl: string } | null; error: unknown }) {
    const createSignedUrl = vi.fn(async (_path: string, _expiresIn: number) => answer);
    const from = vi.fn((_bucket: string) => ({ createSignedUrl }));
    return { storage: { from } as StorageSigner, from, createSignedUrl };
  }

  it('signs the one object, in its own bucket, for the same hour', async () => {
    const s = storage({ data: { signedUrl: 'https://files.example/signed' }, error: null });
    const url = await signerFor(s.storage, 'order-attachments', 'org/order/photo.jpg')();
    expect(url).toBe('https://files.example/signed');
    expect(s.from).toHaveBeenCalledWith('order-attachments');
    expect(s.createSignedUrl).toHaveBeenCalledWith('org/order/photo.jpg', 3600);
  });

  it('a refusal or an empty answer is null', async () => {
    expect(
      await signerFor(storage({ data: null, error: { message: 'not found' } }).storage, 'b', 'p')(),
    ).toBeNull();
    expect(
      await signerFor(storage({ data: { signedUrl: '' }, error: null }).storage, 'b', 'p')(),
    ).toBeNull();
  });
});
