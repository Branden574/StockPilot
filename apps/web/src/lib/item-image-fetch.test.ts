// SSRF: where the server fetches an item image or an organization logo
// (lib/item-image-fetch.ts, shared by the PDF image prefetch, the PDF logo and
// the inventory export). The project origin serves more than Storage: GoTrue's
// /auth/v1/verify answers any bogus token with a 303 to the request's
// redirect_to when it is on the auth redirect allow list, and to the Site URL
// otherwise. So a plain fetch of any path there, following redirects, could be
// led to any host. Only a Storage read path on the exact project origin gets
// plain fetch, and that fetch never follows a redirect; any other http(s) URL
// goes through the SSRF guard with the cover allowlist.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SsrfBlockedError } from '@/lib/ssrf-guard';
import { startLocalServer, type LocalServer } from '@/test/local-http';

import { fetchItemImage, ItemImageUrlRefusedError, itemImageFetchRoute } from './item-image-fetch';

describe('itemImageFetchRoute — what counts as storage', () => {
  const PROJECT = 'https://proj.supabase.co';
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = PROJECT;
    return () => {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
    };
  });

  it('a Storage object read on the project origin: signed, transformed or public', () => {
    for (const url of [
      `${PROJECT}/storage/v1/object/sign/item-images/org/item/thumb.webp?token=t`,
      `${PROJECT}/storage/v1/render/image/sign/item-images/org/item/thumb.webp?token=t`,
      `${PROJECT}/storage/v1/object/public/org-logos/org-1/logo-1.png`,
    ]) {
      expect(itemImageFetchRoute(url), url).toBe('storage');
    }
  });

  it('any other path on the project origin goes through the guard', () => {
    for (const url of [
      `${PROJECT}/auth/v1/verify?type=signup&token=x&redirect_to=https://preview.example.test/auth/callback`,
      `${PROJECT}/rest/v1/inventory_items`,
      `${PROJECT}/functions/v1/anything`,
      `${PROJECT}/storage/v1/bucket`,
      `${PROJECT}/`,
      // Dot segments are resolved before the check, the same way fetch
      // resolves them before the request.
      `${PROJECT}/storage/v1/object/../../../auth/v1/verify?token=x`,
      `${PROJECT}/storage/v1/object/%2e%2e/%2e%2e/%2e%2e/auth/v1/verify?token=x`,
    ]) {
      expect(itemImageFetchRoute(url), url).toBe('external');
    }
  });

  it('the whole origin must match: another project, a look-alike host, the scheme and the port', () => {
    for (const url of [
      'https://other-ref.supabase.co/storage/v1/object/public/org-logos/org-1/logo-1.png',
      'https://proj.supabase.co.example.test/storage/v1/object/public/org-logos/org-1/logo-1.png',
      'http://proj.supabase.co/storage/v1/object/public/org-logos/org-1/logo-1.png',
      'https://proj.supabase.co:8443/storage/v1/object/public/org-logos/org-1/logo-1.png',
    ]) {
      expect(itemImageFetchRoute(url), url).toBe('external');
    }
  });

  it('refuses anything that is not an http(s) URL', () => {
    for (const url of ['file:///etc/hosts', '/var/task/logo.png', 'logo.png', 'not a url']) {
      expect(itemImageFetchRoute(url), url).toBeNull();
    }
  });
});

/**
 * The real fetch against two loopback servers: one stands for the project
 * origin (Storage, and GoTrue's verify redirect), the other for any other
 * host, an internal one included.
 */
describe('fetchItemImage — the real fetch never leaves the project origin', () => {
  const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
  let project: LocalServer;
  let elsewhere: LocalServer;
  let previous: string | undefined;

  beforeAll(async () => {
    elsewhere = await startLocalServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_SIGNATURE);
    });
    project = await startLocalServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://project.local');
      if (url.pathname === '/auth/v1/verify') {
        res.writeHead(303, { location: url.searchParams.get('redirect_to') ?? '/' });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/storage/v1/object/public/org-logos/moved/')) {
        res.writeHead(302, { location: `${elsewhere.origin}/latest/meta-data/logo.png` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_SIGNATURE);
    });
  });
  afterAll(async () => {
    await Promise.all([project?.close(), elsewhere?.close()]);
  });
  beforeEach(() => {
    previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = project.origin;
    project.requests.length = 0;
    elsewhere.requests.length = 0;
    return () => {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
    };
  });

  it('reads a Storage object with one plain request', async () => {
    const path = '/storage/v1/object/public/org-logos/org-1/logo-1.png';
    const res = await fetchItemImage(`${project.origin}${path}`, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_SIGNATURE);
    expect(project.requests).toEqual([path]);
    expect(elsewhere.requests).toEqual([]);
  });

  it('never follows a redirect from Storage: one request, refused, the target never asked', async () => {
    const url = `${project.origin}/storage/v1/object/public/org-logos/moved/logo-1.png`;
    await expect(fetchItemImage(url, new AbortController().signal)).rejects.toBeInstanceOf(
      ItemImageUrlRefusedError,
    );
    expect(project.requests).toHaveLength(1);
    expect(elsewhere.requests).toEqual([]);
  });

  it('never fetches a project path that is not a Storage read: the guard refuses it before any request', async () => {
    const callback = encodeURIComponent(`${elsewhere.origin}/auth/callback`);
    const url = `${project.origin}/auth/v1/verify?type=signup&token=bogus&redirect_to=${callback}`;
    await expect(fetchItemImage(url, new AbortController().signal)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(project.requests).toEqual([]);
    expect(elsewhere.requests).toEqual([]);
  });
});
