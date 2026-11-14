import { describe, expect, it, vi } from 'vitest';

import { PROD_API_FALLBACK, resolveApiUrl } from './api-host';

/**
 * LINKS TO THE WEB APP ARE BUILT FROM THE CONFIGURED HOST (B124).
 *
 * Every "open on the web" link named https://stockpilotusa.com itself, so a
 * lab, preview or development build sent people to production pages. They
 * are now built by webLink (web-links.ts) from the host the app's requests go
 * to (api-host.ts resolveApiUrl, read by api.ts): the web app serves both.
 * A production build resolves that host to https://stockpilotusa.com, so it
 * opens exactly the addresses it opened before; that is pinned below. The
 * helper adds nothing: no query, no token, no identifier but the record's
 * own id that the link already carried in its path.
 */

/** What a production build resolves (eas.json production: EXPO_PUBLIC_API_URL). */
const production = vi.hoisted(() => ({ base: '' }));
vi.mock('./api', () => ({
  get API_BASE() {
    return production.base;
  },
}));

const RENTAL = '0e000000-0000-0000-0000-0000000000e1';
const ITEM = '0f000000-0000-0000-0000-0000000000f1';
const PROCEDURE = '0d000000-0000-0000-0000-0000000000d1';

describe('the host a release build resolves', () => {
  it.each([
    ['the production profile', { fromExtra: 'https://stockpilotusa.com', fromEnv: undefined }],
    [
      'an update published with no host set (app.config falls back to localhost)',
      { fromExtra: 'http://localhost:3000', fromEnv: undefined },
    ],
    ['nothing set at all', { fromExtra: undefined, fromEnv: undefined }],
  ])('%s: https://stockpilotusa.com', (_name, input) => {
    expect(resolveApiUrl({ ...input, dev: false })).toBe('https://stockpilotusa.com');
    expect(PROD_API_FALLBACK).toBe('https://stockpilotusa.com');
  });

  it('a lab or preview build keeps its own host; development may use localhost', () => {
    expect(
      resolveApiUrl({ fromExtra: 'https://lab.example.test', fromEnv: undefined, dev: false }),
    ).toBe('https://lab.example.test');
    expect(resolveApiUrl({ fromExtra: undefined, fromEnv: undefined, dev: true })).toBe(
      'http://localhost:3000',
    );
  });
});

describe('webLink: a production build opens exactly the addresses it opened before', () => {
  it('every link the app opens', async () => {
    production.base = resolveApiUrl({
      fromExtra: 'https://stockpilotusa.com',
      fromEnv: undefined,
      dev: false,
    });
    const { webLink } = await import('./web-links');
    expect([
      webLink(`/dashboard/rentals/${RENTAL}`),
      webLink('/dashboard/settings/profile'),
      webLink('/dashboard/settings/security'),
      webLink('/privacy'),
      webLink('/terms'),
      webLink(`/dashboard/inventory/${ITEM}/edit`),
      webLink(`/dashboard/procedures/${PROCEDURE}`),
      webLink('/dashboard/schedule'),
      webLink('/dashboard/reports'),
    ]).toEqual([
      `https://stockpilotusa.com/dashboard/rentals/${RENTAL}`,
      'https://stockpilotusa.com/dashboard/settings/profile',
      'https://stockpilotusa.com/dashboard/settings/security',
      'https://stockpilotusa.com/privacy',
      'https://stockpilotusa.com/terms',
      `https://stockpilotusa.com/dashboard/inventory/${ITEM}/edit`,
      `https://stockpilotusa.com/dashboard/procedures/${PROCEDURE}`,
      'https://stockpilotusa.com/dashboard/schedule',
      'https://stockpilotusa.com/dashboard/reports',
    ]);
  });

  it('another build opens the same pages on its own host, with nothing added', async () => {
    const { webLink } = await import('./web-links');
    expect(webLink('/dashboard/schedule', 'https://lab.example.test')).toBe(
      'https://lab.example.test/dashboard/schedule',
    );
    // A host written with a trailing slash never doubles it.
    expect(webLink('/terms', 'https://lab.example.test/')).toBe('https://lab.example.test/terms');
  });
});
