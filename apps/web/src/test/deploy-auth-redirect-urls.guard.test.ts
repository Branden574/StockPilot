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
 * Site URL) and a local URL, nothing else, and no host on it has a wildcard.
 * A wildcard in the path of an exact host (`https://example.com/**`) is fine:
 * the host is what decides who can serve the page.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

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

/** The host of an http(s) URL as written, wildcards included; '' when there is none. */
function hostOf(url: string): string {
  const m = /^https?:\/\/(?:[^@/\s]*@)?(\[[^\]]*\]|[^:/\s?#]+)/i.exec(url);
  return m?.[1]?.toLowerCase() ?? '';
}

type RedirectSettings = { siteUrl: string; redirectUrls: string[] };

/** Reads `Site URL:` and the indented URLs under `Redirect URLs:` from one block. */
function parseSettings(block: string): RedirectSettings {
  let siteUrl = '';
  const redirectUrls: string[] = [];
  let inRedirects = false;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    const site = /^Site URL:\s*(\S+)$/.exec(line);
    if (site) {
      siteUrl = site[1] ?? '';
      inRedirects = false;
      continue;
    }
    if (/^Redirect URLs:\s*$/.test(line)) {
      inRedirects = true;
      continue;
    }
    const entry = /^\s+(\S+)$/.exec(line);
    if (inRedirects && entry) {
      redirectUrls.push(entry[1] ?? '');
      continue;
    }
    if (line.trim() !== '') inRedirects = false;
  }
  return { siteUrl, redirectUrls };
}

describe('DEPLOY.md auth redirect URLs', () => {
  const section = redirectSection(readFileSync(join(REPO_ROOT, 'DEPLOY.md'), 'utf8'));
  const blocks = fencedBlocks(section).filter((b) => /^Redirect URLs:/m.test(b));

  it('has the section and one block that sets the redirect URLs', () => {
    expect(section).not.toBe('');
    expect(blocks).toHaveLength(1);
  });

  it('names the production site and a local URL only, with no wildcard host', () => {
    const { siteUrl, redirectUrls } = parseSettings(blocks[0] ?? '');
    const siteHost = hostOf(siteUrl);
    expect(siteHost).not.toBe('');
    expect(siteHost).not.toContain('*');
    expect(redirectUrls.length).toBeGreaterThan(0);

    const problems = redirectUrls.flatMap((url) => {
      const host = hostOf(url);
      if (host === '') return [`${url}: not an http(s) URL`];
      if (host.includes('*')) return [`${url}: wildcard host`];
      if (host === siteHost || LOCAL_HOSTS.has(host)) return [];
      return [`${url}: neither the Site URL's host nor a local host`];
    });
    expect(problems).toEqual([]);
    // The production site itself is on the list.
    expect(redirectUrls.map(hostOf)).toContain(siteHost);
  });
});

describe('the parsing this guard relies on', () => {
  it('reads the old wildcard entry as a wildcard host', () => {
    const { siteUrl, redirectUrls } = parseSettings(
      [
        'Site URL:  https://site.example.com',
        'Redirect URLs:',
        '  https://site.example.com/auth/callback',
        '  https://*.vercel.app/auth/callback   # for preview deploys',
      ].join('\n'),
    );
    expect(hostOf(siteUrl)).toBe('site.example.com');
    expect(redirectUrls.map(hostOf)).toEqual(['site.example.com', '*.vercel.app']);
  });

  it('keeps a path wildcard on an exact host apart from a host wildcard', () => {
    expect(hostOf('https://site.example.com/**')).toBe('site.example.com');
    expect(hostOf('https://*-team.vercel.app/**')).toBe('*-team.vercel.app');
    expect(hostOf('http://localhost:3000/auth/callback')).toBe('localhost');
    expect(hostOf('https://user@site.example.com/x')).toBe('site.example.com');
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
