import { expect, test } from '@playwright/test';

import { buildRollout, cookieFor, fetchAs, MARKETING_PATHS, type Rollout } from './site-look';

/**
 * Identical indexable metadata between each classic marketing page and its
 * Liquid Glass twin (plans/REVISION-DEFAULT.md R8, section 9 item 44): under
 * `default` a crawler (no cookie) gets the twin at the public address, so the
 * twin must say exactly what the classic page says, and must not say noindex
 * (a noindex served at / would take the site out of search). Compared as
 * served: <title>, every <meta name|property> (description, robots, Open
 * Graph, Twitter), <link rel=canonical|alternate|icon|manifest> and every
 * JSON-LD block, as sorted lists (order in <head> is not indexable meaning).
 * The appearance head script, hashed asset links and the build's own
 * preloads are not metadata and are left out.
 *
 * Needs a running server: the integrator's lab run. Unit half:
 * app/(site-glass)/glass-site/twins.test.tsx (the exported metadata objects).
 */

let rollout: Rollout;
test.beforeAll(async ({ request }) => {
  rollout = await buildRollout(request);
});

function headEntries(html: string): string[] {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? '';
  const out: string[] = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/u.exec(head)?.[1];
  if (title !== undefined) out.push(`title ${title}`);
  for (const m of head.matchAll(/<meta\s[^>]*>/gu)) {
    const tag = m[0];
    const key = /\s(name|property)="([^"]+)"/u.exec(tag);
    if (!key) continue;
    const content = /\scontent="([^"]*)"/u.exec(tag)?.[1] ?? '';
    out.push(`meta ${key[1]}=${key[2]} ${content}`);
  }
  for (const m of head.matchAll(/<link\s[^>]*>/gu)) {
    const tag = m[0];
    const rel = /\srel="([^"]+)"/u.exec(tag)?.[1] ?? '';
    if (!/^(canonical|alternate|icon|apple-touch-icon|manifest)$/u.test(rel)) continue;
    const href = /\shref="([^"]+)"/u.exec(tag)?.[1] ?? '';
    out.push(`link ${rel} ${href}`);
  }
  for (const m of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gu,
  )) {
    out.push(`ld+json ${m[1]!.trim()}`);
  }
  return out.sort();
}

test('each twin serves exactly its classic page’s indexable head, and no noindex', async ({
  request,
}) => {
  test.skip(rollout === 'off', 'off: no twin is served');
  for (const path of MARKETING_PATHS) {
    const classic = headEntries(await (await fetchAs(request, path, 'classic')).text());
    const twinHtml = await (
      await fetchAs(request, path, cookieFor(rollout, 'liquid-glass'))
    ).text();
    expect(twinHtml, `${path}: the twin was served`).toContain('data-lg-twin');
    const twin = headEntries(twinHtml);
    expect(
      classic.some((e) => e.startsWith('title ')),
      `${path} has a title`,
    ).toBe(true);
    expect(twin, path).toEqual(classic);
    expect(twin.join('\n'), path).not.toMatch(/noindex|nofollow/iu);
    // The canonical, where the page names one, is its public address, never /glass-site.
    for (const entry of twin.filter((e) => e.startsWith('link canonical '))) {
      expect(entry, path).not.toContain('/glass-site');
    }
  }
});

test('the sitemap and robots are the same whatever the cookie, and never list /glass-site', async ({
  request,
}) => {
  for (const file of ['/sitemap.xml', '/robots.txt']) {
    const plain = await (await fetchAs(request, file, null)).text();
    const classic = await (await fetchAs(request, file, 'classic')).text();
    expect(plain, file).toBe(classic);
    expect(plain, file).not.toContain('/glass-site');
  }
});
