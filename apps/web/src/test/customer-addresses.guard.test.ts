import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No address at the customer's mail domains in the tracked tree (docket S15,
 * 2026-10-25).
 *
 * WHAT WAS THERE: tests, fixtures, docs and comments carried real people's
 * addresses at the customer's mail domains, beside their names, and a parser
 * fixture was a real purchase order. The repository is public. Each is
 * synthetic now: people at reserved domains (example.org, *.test, *.example),
 * the intake mailbox and the copied lead at sampleorg.test and site1.test
 * (same lengths, so the measured mail-link budgets did not move), and the
 * purchase order a synthetic document in the same layout.
 *
 * WHAT STOPS IT NOW: this test lists every tracked file (`git ls-files`),
 * reads each text file and fails on an address at one of the customer's mail
 * domains, in every spelling a file here can hold: any case, under a
 * subdomain, the @ written as %40 or an HTML entity, the dots escaped for a
 * regular expression. The only addresses allowed are the (file, address)
 * pairs in ALLOWED, each with its reason; they are held as sha256 of the
 * address in lower case, so this file names none of them. An allowed pair
 * that is no longer in its file fails too, so the list cannot outlive its
 * reason.
 *
 * NOT COVERED: binary files (images, PDFs and fonts), whose text this test
 * cannot read; files named .env* (the two tracked templates hold variable
 * names only, and a test that opens .env files is one rename away from
 * opening a real one); names, which no pattern can tell from words. Git
 * history keeps the old content.
 *
 * IF THIS FAILS: replace the address with a synthetic one at a reserved
 * domain (example.org, example.com, *.test, *.example) and keep the test's
 * intent (the same length where a test measures one). Add a pair to ALLOWED
 * only for a file that can never change (an applied migration) or an address
 * the product must name, with the reason on its line.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

// The customer's mail domains, joined from pieces at run time so that this
// file never holds one whole and a search of the repository for one finds
// only the applied migration allowed below.
const CUSTOMER_DOMAINS: readonly string[] = [
  ['learn' + '4life', 'org'],
  ['l4l' + 'north', 'com'],
  ['l4' + 'l', 'org'],
  ['cv' + 'west', 'org'],
  ['cv' + 'south', 'org'],
  ['ll' + 'ac', 'org'],
].map((labels) => labels.join('.'));

type Allowed = { file: string; sha256: string; why: string };

const ALLOWED: readonly Allowed[] = [
  {
    file: 'supabase/migrations/0337_org_email_routing.sql',
    sha256: '571d1c0683917b1d41e9834ce32e1bc6834c85e45037d5dfd7913faa80d16b81',
    why: "applied migration: seeds the customer's DC4 intake mailbox as its delivery and maintenance TO; an applied migration is never edited",
  },
  {
    file: 'supabase/migrations/0337_org_email_routing.sql',
    sha256: '69dfab5a18e49bac58b4ee45c8f0e828aaecfa245b296b94e6bc80b7c85e892e',
    why: 'applied migration: the same seed copies the DC4 lead on both request kinds; an applied migration is never edited',
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A dot may be written escaped once or twice (a regular expression, or one
// inside a string literal).
const DOT = String.raw`\\{0,2}\.`;
const AT = String.raw`(?:\\?@|%40|&#0*64;|&#x0*40;|&commat;)`;
const LABEL = '[A-Za-z0-9-]+';
const DOMAINS = CUSTOMER_DOMAINS.map((d) => d.split('.').map(escapeRe).join(DOT)).join('|');

/** An address at a customer domain or one of its subdomains, and nothing longer. */
const ADDRESS = new RegExp(
  `[A-Za-z0-9._%+-]+${AT}(?:${LABEL}${DOT})*(?:${DOMAINS})(?![A-Za-z0-9-])(?!${DOT}[A-Za-z0-9-])`,
  'gi',
);

/** The address as the allowlist hashes it: lower case, @ and dots unescaped. */
function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\\?@|%40|&#0*64;|&#x0*40;|&commat;/g, '@')
    .replace(/\\+\./g, '.');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const BINARY_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|ico|icns|heic|pdf|woff2?|ttf|otf|eot|mp3|mp4|mov|webm|wav|zip|gz|tgz|br)$/i;

type Found = { file: string; line: number; sha256: string; domain: string };

function findIn(file: string, text: string): Found[] {
  const found: Found[] = [];
  text.split('\n').forEach((content, i) => {
    for (const match of content.matchAll(ADDRESS)) {
      const address = normalise(match[0]);
      found.push({
        file,
        line: i + 1,
        sha256: sha256(address),
        domain: address.slice(address.indexOf('@') + 1),
      });
    }
  });
  return found;
}

let scanned: Found[] | undefined;

function scanTrackedTree(): Found[] {
  if (scanned) return scanned;
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0)
    .filter((file) => !BINARY_EXTENSION.test(file) && !basename(file).startsWith('.env'));
  // Only a file that names a domain's first label can hold an address there.
  const hint = new RegExp(CUSTOMER_DOMAINS.map((d) => escapeRe(d.split('.')[0]!)).join('|'), 'i');
  const found: Found[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(REPO_ROOT, file));
    } catch {
      continue; // listed but not on disk (deleted in a working tree)
    }
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    const text = bytes.toString('utf8');
    if (!hint.test(text)) continue;
    found.push(...findIn(file, text));
  }
  scanned = found;
  return found;
}

describe("the tracked tree holds no address at the customer's mail domains", () => {
  it('finds none outside the allowed (file, address) pairs', () => {
    const unexpected = scanTrackedTree()
      .filter((f) => !ALLOWED.some((a) => a.file === f.file && a.sha256 === f.sha256))
      .map((f) => `${f.file}:${f.line} (an address at ${f.domain})`);
    expect(unexpected).toEqual([]);
  }, 60_000);

  it('still finds every allowed pair in its file', () => {
    const found = scanTrackedTree();
    const stale = ALLOWED.filter(
      (a) => !found.some((f) => f.file === a.file && f.sha256 === a.sha256),
    );
    expect(stale.map((a) => `${a.file} (${a.why})`)).toEqual([]);
  }, 60_000);

  it('gives every allowed pair a reason and lists each pair once', () => {
    for (const a of ALLOWED) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.why.length).toBeGreaterThan(20);
    }
    expect(new Set(ALLOWED.map((a) => `${a.file} ${a.sha256}`)).size).toBe(ALLOWED.length);
  });

  it('the pattern finds each spelling of an address and leaves lookalikes alone', () => {
    // Built from the pieces above at run time, like the domains themselves.
    for (const domain of CUSTOMER_DOMAINS) {
      const [label, tld] = domain.split('.') as [string, string];
      const plain = `intake@${domain}`;
      const spellings = [
        plain,
        `Reach ${plain.toUpperCase()} today`,
        `mailto:${plain}?subject=Hello`,
        `intake%40${domain}`,
        `intake&#64;${domain}`,
        `intake@mail.${domain}`,
        String.raw`/^intake@${label}\.${tld}$/`,
        String.raw`'intake@${label}\\.${tld}'`,
        `Write to ${plain}.`,
      ];
      for (const text of spellings) {
        const found = findIn('sample.txt', text);
        expect(found, text).toHaveLength(1);
        const expected = text.includes('mail.') ? `intake@mail.${domain}` : plain;
        expect(found[0]!.sha256, text).toBe(sha256(expected));
      }
      const lookalikes = [
        `https://www.${domain}/`,
        `the ${label} portal`,
        `intake@not${domain}`,
        `intake@${domain}.example`,
        `intake@${label}.${tld}x`,
        `intake@${label}-${tld}.test`,
      ];
      for (const text of lookalikes) {
        expect(findIn('sample.txt', text), text).toEqual([]);
      }
    }
    // The synthetic stand-ins are no customer domain.
    expect(
      findIn('sample.txt', 'dc4@sampleorg.test cc jstone@site1.test, pat@example.org'),
    ).toEqual([]);
  });
});
