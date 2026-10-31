import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * C9 (2026-10-31): the auth redirect URLs DEPLOY.md tells a reader to set on
 * the hosted Supabase project.
 *
 * WHAT WAS WRONG: section 3 listed `https://*.vercel.app/auth/callback` "for
 * preview deploys". Supabase Auth sends a sign-in link's session to the
 * redirect address the link names whenever that address matches an entry on
 * this list, and anyone with a Vercel account can deploy a site at an address
 * that matches `*.vercel.app`. A project set up from the doc would hand such a
 * site the session of anyone who opened a link naming it.
 *
 * WHAT HOLDS IT NOW: the block in that section names the production site (its
 * Site URL) and a local URL, nothing else, on https unless the host is local,
 * and no host on it has a wildcard. A wildcard in the path of an exact host
 * (`https://example.com/**`) is fine: the host is what decides who can serve
 * the page.
 *
 * HOW SUPABASE READS THE LIST, and so what counts as a wildcard here. Supabase
 * Auth compiles each entry as a glob with `.` and `/` as separators
 * (`glob.MustCompile(uri, '.', '/')`): `*` matches any run of characters but
 * those two and `?` any one such character, `**` matches anything, `[...]` is
 * a class and `{a,b}` a choice. It also accepts any address with the Site
 * URL's scheme, host and port. So:
 * - any of `* ? [ ] { }` between `://` and the first `/` (user-info, host or
 *   port) lets an entry match other hosts: `https://localhost?evil.example/**`
 *   matches `https://localhost-evil.example/`. An IPv6 literal such as `[::1]`
 *   is refused too; as a glob it would not match that address anyway.
 * - every value in the block counts, wherever it is written: two URLs on one
 *   line, a comma list, a value on the `Redirect URLs:` line itself, a line
 *   after a blank one. A line that is not a setting or an entry is reported,
 *   and every http(s) URL anywhere in the block, comments included, must be
 *   one this guard checked.
 * - a session must not travel over plain http: the Site URL, and every entry
 *   whose host is not local, is https.
 * The first version of this guard read one bare URL per line, stopped reading
 * a host at `?` and did not look at the scheme (security review, 2026-10-31).
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/** Supabase's glob characters: `*`, `?`, a `[...]` class and a `{a,b}` choice. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/** Every http(s) URL written in a text, up to a space or a comma. */
const HTTP_URLS = /https?:\/\/[^\s,]+/gi;

/** DEPLOY.md's "Supabase auth redirect URLs" section, up to the next `## ` heading. */
function redirectSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^## \d+\. Supabase auth redirect URLs\s*$/.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The contents of each fenced code block in `text`. */
function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm)].map((m) => m[1] ?? '');
}

/**
 * An http(s) URL's scheme and authority (everything between `://` and the
 * first `/`: user-info, host and port), lower-cased; null for anything else.
 */
function urlParts(url: string): { scheme: string; authority: string } | null {
  const m = /^(https?):\/\/([^/]*)/i.exec(url);
  if (!m) return null;
  return { scheme: (m[1] ?? '').toLowerCase(), authority: (m[2] ?? '').toLowerCase() };
}

/**
 * The host of an http(s) URL as written, glob characters included, without
 * user-info or port; '' when there is none. It runs to the first `/`, not to
 * a `?` or `#`: an entry is a glob, where neither ends the host as it would in
 * a URL.
 */
function hostOf(url: string): string {
  const authority = urlParts(url)?.authority ?? '';
  return authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/, '');
}

type RedirectSettings = {
  /** Every value on a `Site URL:` line; there should be one. */
  siteUrls: string[];
  /** Every value on the `Redirect URLs:` line and on the indented lines after it. */
  redirectUrls: string[];
  /** Lines that are none of those and not blank. */
  strayLines: string[];
};

/**
 * Reads one settings block. A ` # comment` is dropped first, and values are
 * split on spaces and commas. A blank or comment-only line neither ends the
 * list nor adds to it; only a `Site URL:` line ends it.
 */
function parseSettings(block: string): RedirectSettings {
  const settings: RedirectSettings = { siteUrls: [], redirectUrls: [], strayLines: [] };
  const values = (text: string) => text.split(/[\s,]+/).filter((v) => v !== '');
  let inRedirects = false;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/(?:^|\s)#.*$/, '').trimEnd();
    const site = /^Site URL:(.*)$/.exec(line);
    const list = /^Redirect URLs:(.*)$/.exec(line);
    if (site) {
      settings.siteUrls.push(...values(site[1] ?? ''));
      inRedirects = false;
    } else if (list) {
      settings.redirectUrls.push(...values(list[1] ?? ''));
      inRedirects = true;
    } else if (line.trim() === '') {
      continue;
    } else if (inRedirects && /^\s/.test(line)) {
      settings.redirectUrls.push(...values(line));
    } else {
      settings.strayLines.push(line.trim());
    }
  }
  return settings;
}

/** Why the Site URL is not allowed, or null when it is. */
function siteUrlProblem(siteUrl: string): string | null {
  const parts = urlParts(siteUrl);
  if (!parts) return 'not an http(s) URL';
  if (GLOB_CHARACTERS.test(parts.authority)) return 'wildcard host';
  if (hostOf(siteUrl) === '') return 'no host';
  return parts.scheme === 'https' ? null : 'not https';
}

/** Why one Redirect URLs entry is not allowed, or null when it is. */
function entryProblem(url: string, siteHost: string): string | null {
  const parts = urlParts(url);
  if (!parts) return 'not an http(s) URL';
  if (GLOB_CHARACTERS.test(parts.authority)) return 'wildcard host';
  const host = hostOf(url);
  if (host === '') return 'no host';
  if (LOCAL_HOSTS.has(host)) return null;
  if (parts.scheme !== 'https') return 'http on a host that is not local';
  return host === siteHost ? null : "neither the Site URL's host nor a local host";
}

/** Everything wrong with one settings block, one line each; empty when nothing is. */
function problemsIn(block: string): string[] {
  const { siteUrls, redirectUrls, strayLines } = parseSettings(block);
  const problems = strayLines.map((line) => `a line that is not a setting or an entry: ${line}`);

  if (siteUrls.length !== 1) problems.push(`expected one Site URL, found ${siteUrls.length}`);
  const siteUrl = siteUrls[0] ?? '';
  const siteWhy = siteUrlProblem(siteUrl);
  if (siteWhy) problems.push(`Site URL ${siteUrl}: ${siteWhy}`);

  const siteHost = hostOf(siteUrl);
  if (redirectUrls.length === 0) problems.push('no redirect URLs');
  for (const url of redirectUrls) {
    const why = entryProblem(url, siteHost);
    if (why) problems.push(`${url}: ${why}`);
  }
  // The production site itself is on the list.
  if (!redirectUrls.map(hostOf).includes(siteHost)) {
    problems.push("the Site URL's host is not on the list");
  }

  // Every http(s) URL in the block is one checked above. Each value checked
  // above must itself be an http(s) URL, so the two sets are equal.
  const checked = new Set([...siteUrls, ...redirectUrls]);
  for (const url of new Set(block.match(HTTP_URLS))) {
    if (!checked.has(url)) problems.push(`${url}: in the block but not checked`);
  }
  return problems;
}

describe('DEPLOY.md auth redirect URLs', () => {
  const section = redirectSection(readFileSync(join(REPO_ROOT, 'DEPLOY.md'), 'utf8'));
  const blocks = fencedBlocks(section).filter((b) => /^Redirect URLs:/m.test(b));

  it('has the section and one block that sets the redirect URLs', () => {
    expect(section).not.toBe('');
    expect(blocks).toHaveLength(1);
  });

  it('names the production site and a local URL only, on https unless local, with no wildcard host', () => {
    expect(problemsIn(blocks[0] ?? '')).toEqual([]);
  });
});

describe('the checks this guard relies on', () => {
  const SITE = 'https://site.example.com';
  const CALLBACK = `  ${SITE}/auth/callback`;
  /** A settings block with this Site URL and these lines after `Redirect URLs:`. */
  const settingsBlock = (siteUrl: string, ...listLines: string[]) =>
    [`Site URL:  ${siteUrl}`, 'Redirect URLs:', ...listLines].join('\n');

  it('passes the production site and local URLs, with a path wildcard on the exact host', () => {
    const block = settingsBlock(
      SITE,
      CALLBACK,
      `  ${SITE}/**`,
      '  http://localhost:3000/auth/callback   # local development',
      '  http://127.0.0.1:3000/auth/callback',
    );
    expect(problemsIn(block)).toEqual([]);
  });

  it('refuses the old wildcard entry', () => {
    const block = settingsBlock(
      SITE,
      CALLBACK,
      '  https://*.vercel.app/auth/callback   # for preview deploys',
    );
    expect(problemsIn(block)).toEqual(['https://*.vercel.app/auth/callback: wildcard host']);
  });

  it('checks every URL on a line, split on spaces and commas, wherever the line is', () => {
    const local = '  http://localhost:3000/auth/callback';
    const twoOnALine = settingsBlock(SITE, CALLBACK, `${local} https://*.vercel.app/auth/callback`);
    expect(parseSettings(twoOnALine).redirectUrls).toEqual([
      `${SITE}/auth/callback`,
      'http://localhost:3000/auth/callback',
      'https://*.vercel.app/auth/callback',
    ]);
    expect(problemsIn(twoOnALine)).toEqual(['https://*.vercel.app/auth/callback: wildcard host']);
    expect(problemsIn(settingsBlock(SITE, CALLBACK, `${local}, https://*.vercel.app/**`))).toEqual([
      'https://*.vercel.app/**: wildcard host',
    ]);
    // On the Redirect URLs line itself, and after a blank line.
    expect(
      problemsIn(
        [`Site URL:  ${SITE}`, `Redirect URLs: ${SITE}/**, https://*.vercel.app/**`].join('\n'),
      ),
    ).toEqual(['https://*.vercel.app/**: wildcard host']);
    expect(problemsIn(settingsBlock(SITE, CALLBACK, '', '  https://*.vercel.app/**'))).toEqual([
      'https://*.vercel.app/**: wildcard host',
    ]);
  });

  it('reports a line that is not a setting or an entry, and a URL it did not check', () => {
    expect(problemsIn(settingsBlock(SITE, CALLBACK, '**'))).toEqual([
      'a line that is not a setting or an entry: **',
    ]);
    expect(problemsIn(settingsBlock(SITE, `${CALLBACK}   # or https://*.vercel.app/**`))).toEqual([
      'https://*.vercel.app/**: in the block but not checked',
    ]);
    expect(problemsIn(settingsBlock(SITE, CALLBACK, 'Previews: https://*.vercel.app/**'))).toEqual([
      'a line that is not a setting or an entry: Previews: https://*.vercel.app/**',
      'https://*.vercel.app/**: in the block but not checked',
    ]);
  });

  it("refuses a glob character anywhere between '://' and the first '/' of an entry", () => {
    for (const entry of [
      'https://localhost?evil.example/**',
      'https://site.example.co[m]/**',
      'https://*@site.example.com/**',
      'http://localhost:*/auth/callback',
    ]) {
      expect(problemsIn(settingsBlock(SITE, CALLBACK, `  ${entry}`)), entry).toEqual([
        `${entry}: wildcard host`,
      ]);
    }
    // A choice of hosts is split at its comma, and neither half passes.
    expect(
      problemsIn(settingsBlock(SITE, CALLBACK, '  https://{site.example.com,evil.example}/**')),
    ).toEqual(['https://{site.example.com: wildcard host', 'evil.example}/**: not an http(s) URL']);
  });

  it("refuses a glob character in the Site URL's host", () => {
    const block = settingsBlock('https://site?example.com', '  https://site?example.com/**');
    expect(problemsIn(block)).toEqual([
      'Site URL https://site?example.com: wildcard host',
      'https://site?example.com/**: wildcard host',
    ]);
  });

  it('requires https for the Site URL and for every entry whose host is not local', () => {
    expect(problemsIn(settingsBlock(SITE, '  http://site.example.com/auth/callback'))).toEqual([
      'http://site.example.com/auth/callback: http on a host that is not local',
    ]);
    const httpSite = settingsBlock(
      'http://site.example.com',
      '  http://site.example.com/auth/callback',
    );
    expect(problemsIn(httpSite)).toEqual([
      'Site URL http://site.example.com: not https',
      'http://site.example.com/auth/callback: http on a host that is not local',
    ]);
  });

  it('wants one Site URL, and the production site on the list', () => {
    expect(problemsIn(settingsBlock(`${SITE} https://other.example.com`, CALLBACK))).toEqual([
      'expected one Site URL, found 2',
    ]);
    expect(problemsIn(settingsBlock(SITE, '  http://localhost:3000/auth/callback'))).toEqual([
      "the Site URL's host is not on the list",
    ]);
  });

  it('reads a host up to the first slash, without its user-info or port', () => {
    expect(hostOf('https://site.example.com/**')).toBe('site.example.com');
    expect(hostOf('https://*-team.vercel.app/**')).toBe('*-team.vercel.app');
    expect(hostOf('http://localhost:3000/auth/callback')).toBe('localhost');
    expect(hostOf('https://user@site.example.com/x')).toBe('site.example.com');
    expect(hostOf('https://localhost?evil.example/**')).toBe('localhost?evil.example');
    expect(hostOf('site.example.com/auth/callback')).toBe('');
  });

  it('finds the section only up to the next heading', () => {
    const s = redirectSection(
      [
        '# T',
        '## 3. Supabase auth redirect URLs',
        'a',
        '```',
        'Redirect URLs:',
        '```',
        '## 4. Next',
        'b',
      ].join('\n'),
    );
    expect(s).toContain('a');
    expect(s).not.toContain('## 4. Next');
    expect(fencedBlocks(s)).toEqual(['Redirect URLs:\n']);
  });
});
