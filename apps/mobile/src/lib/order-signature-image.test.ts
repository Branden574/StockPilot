import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOrderSignatureImage,
  orderSignatureImagePath,
  type SignatureImageGet,
} from './order-signature-image';

// Migration 0389: "View signature" on the order screen reads the captured
// image through GET /api/v1/orders/<id>/signature (the web's gated route:
// an order approver or the assigned driver) instead of selecting
// signature_data_url from the order row every member reads. Slice C then
// moves stored images off that row; a phone on this update keeps showing them.

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function apiError(status: number): Error {
  return Object.assign(new Error(`Request failed (${status}).`), { status });
}

function getter(answer: () => Promise<unknown>) {
  const paths: string[] = [];
  const fn: SignatureImageGet = async (path) => {
    paths.push(path);
    return answer();
  };
  return { fn, paths };
}

describe('fetchOrderSignatureImage', () => {
  it('reads the image through the /api/v1 alias of the gated signature route', async () => {
    const g = getter(async () => ({ signatureDataUrl: IMAGE }));
    expect(await fetchOrderSignatureImage(g.fn, 'o-1')).toBe(IMAGE);
    expect(g.paths).toEqual(['/api/v1/orders/o-1/signature']);
    expect(orderSignatureImagePath('a b')).toBe('/api/v1/orders/a%20b/signature');
  });

  it('a viewer who is neither an approver nor the driver (403) gets the empty state, quietly', async () => {
    const g = getter(async () => {
      throw apiError(403);
    });
    expect(await fetchOrderSignatureImage(g.fn, 'o-1')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('no image (a paper signature), or anything that is not an image data URL, is null', async () => {
    expect(await fetchOrderSignatureImage(getter(async () => ({ signatureDataUrl: null })).fn, 'o')).toBeNull();
    expect(await fetchOrderSignatureImage(getter(async () => ({})).fn, 'o')).toBeNull();
    expect(
      await fetchOrderSignatureImage(getter(async () => ({ signatureDataUrl: 'javascript:alert(1)' })).fn, 'o'),
    ).toBeNull();
  });

  it('never throws: a server error or no connection is null, said in the device log', async () => {
    expect(
      await fetchOrderSignatureImage(
        getter(async () => {
          throw apiError(500);
        }).fn,
        'o',
      ),
    ).toBeNull();
    expect(
      await fetchOrderSignatureImage(
        getter(async () => {
          throw new Error('Network request failed');
        }).fn,
        'o',
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
