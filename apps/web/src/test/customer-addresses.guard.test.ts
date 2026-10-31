import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CUSTOMER_DOMAINS } from './customer-identity';

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
 * reads every path and each file its extension does not skip, and fails on an
 * address at one of the customer's mail domains. A symbolic link is never
 * followed: git publishes it as the path it points to, so that path is read
 * as a path too, whatever the link is named. A file is read as UTF-8 (NUL
 * bytes and all) and, behind a byte-order mark, as UTF-16 too. A path is read
 * one folder or file name at a time, as written and with its extensions taken
 * off one at a time, and in a name an address is found whatever follows it
 * (<address>.csv, <address>-2026.csv, <address>_old.csv, <address>2026.csv,
 * a folder <address>-backup): a name has no prose to protect, and a suffix in
 * it cannot be told from a longer domain, so a path fails closed, while in a
 * file a longer domain (<address>.example, <address>-mail.example) is left
 * alone. Each line, and each name, is read twice, and an address in either
 * reading is a finding, once per line (or path) and address, so the guard
 * fails closed:
 *
 * - As written: in any case, under a subdomain, with the @ and the dots
 *   escaped with backslashes (a regular expression, or one inside a string
 *   literal), URL-encoded once or more (an Outlook compose link carries
 *   %2540), as HTML references, as \u0040 or \x40 escapes, as quoted-printable
 *   =40 and =2E, or in brackets ([@], (at), [.], [dot]), and with a quoted
 *   local part. Each address in a compose link is found and hashed on its
 *   own, because a local part never starts inside an escape.
 * - Decoded: %-escapes undone (a malformed one left as it is), then HTML
 *   references, backslash escapes (\uXXXX, \u{X}, \xXX, \UXXXXXXXX, octal) and
 *   SQL U&'\XXXX' strings, <br> and <wbr> read as breaks, and full-width and
 *   other compatibility forms folded, round after round until nothing changes
 *   (16 rounds at most), so any mix of them reads plain. There a local part
 *   may follow anything, even a %, and an address is still found across a
 *   character that does not show (a soft hyphen, a zero-width space, <wbr>,
 *   the NUL bytes of UTF-16 text with no byte-order mark), a quoted-printable
 *   soft line break, or a line break after its local part (\n, %0A, &#10;,
 *   <br>).
 *
 * The last tests list every spelling and the lookalikes it leaves alone. The
 * only addresses allowed are the (file, address) pairs in ALLOWED, each with
 * its reason; they are held as sha256 of the address in lower case, so this
 * file names none of them. An allowed pair that is no longer in its file
 * fails too, so the list cannot outlive its reason.
 *
 * NOT COVERED: the contents of files skipped by their extension (images, PDFs,
 * fonts, media and archives), whose text this test cannot read, and of files
 * named .env* (the two tracked templates hold variable names only, and a test
 * that opens .env files is one rename away from opening a real one), though
 * their paths are read; people's names, which no pattern can tell from words;
 * an address split across folder levels (a / inside it); and an address split
 * across lines of the file, put together at run time from pieces (as the
 * domains in customer-identity.ts are), broken up by other markup or by
 * spaces, written in words with no brackets, spelled with lookalike letters
 * from another script, or in an encoding not listed above (base64, for one).
 * Git history keeps the old content.
 *
 * IF THIS FAILS: replace the address with a synthetic one at a reserved
 * domain (example.org, example.com, *.test, *.example), rename the file or
 * folder that names one, or point a link that names one elsewhere, and keep
 * the test's intent (the same length where a test measures one). Add a pair
 * to ALLOWED only for a file that can never change (an applied migration) or
 * an address the product must name, with the reason on its line.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

// The customer's mail domains (CUSTOMER_DOMAINS) come from customer-identity.ts,
// which joins them from pieces at run time, so that neither file holds one
// whole and a search of the repository for one finds only the applied
// migration allowed below. The copy guard (customer-names-in-copy.guard.test.ts)
// reads the same list.

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

// A dot as written: plain or escaped with backslashes (a regular expression,
// or one inside a string literal), URL-encoded once or more, an HTML
// reference, a JavaScript or JSON escape, a quoted-printable =2E (an RFC 2047
// header word), or in brackets.
const DOT_SOURCE = String.raw`\\*\.|%(?:25)*2E|&#0*46;|&#x0*2E;|&period;|\\+(?:u002E|u\{0*2E\}|x2E)|=2E|[ \t]*[[({][ \t]*(?:\.|dot)[ \t]*[\])}][ \t]*`;
// The @ in the same ways: plain or escaped with backslashes, URL-encoded once
// or more (%40, %2540, ...), an HTML reference, a JavaScript or JSON escape,
// a quoted-printable =40, or in brackets.
const AT_SOURCE = String.raw`\\*@|%(?:25)*40|&#0*64;|&#x0*40;|&commat;|\\+(?:u0040|u\{0*40\}|x40)|=40|[ \t]*[[({][ \t]*(?:@|at)[ \t]*[\])}][ \t]*`;
const DOT = `(?:${DOT_SOURCE})`;
const AT = `(?:${AT_SOURCE})`;
// A local part never starts inside an escape: in `%3Cintake%2540...` or
// `%253Cintake%2540...` the address is `intake`, not `3Cintake`, and in a
// string's `Hello\nintake@...` it is `intake`, not `nintake`. A % or a
// backslash is therefore not a local-part character either, so two encoded
// addresses in one link never run together into one match. The decoded
// reading has no escapes left and drops this rule, so `100%ab@...` is found.
// A quoted local part ("intake"@...) is the same address.
const LOCAL = String.raw`(?:"[A-Za-z0-9._+-]+"|(?<!%(?:25)*[0-9A-Fa-f]?|\\(?:u\{?[0-9A-Fa-f]{0,3}|U[0-9A-Fa-f]{0,7}|x[0-9A-Fa-f]?|[0-7]{1,2})?)[A-Za-z0-9._+-]+)`;
const LABEL = '[A-Za-z0-9_-]+';
const DOMAINS = CUSTOMER_DOMAINS.map((d) => d.split('.').map(escapeRe).join(DOT)).join('|');
const ADDRESS_SOURCE = `${LOCAL}${AT}(?:${LABEL}${DOT})*(?:${DOMAINS})`;
// In a file: nothing longer, no further label character (a hyphen only when a
// letter or digit follows it, so a dash after the address still ends it) and
// no further dot and label, so prose can name a longer domain. A path has no
// tail (PATH_ADDRESS below).
const TAIL = `(?!-?[A-Za-z0-9])(?!${DOT}[A-Za-z0-9-])`;

/** An address at a customer domain or one of its subdomains, as written. */
const ADDRESS = new RegExp(`${ADDRESS_SOURCE}${TAIL}`, 'gi');

// Breaks the decoded reading finds an address across. A character that does
// not show (a soft hyphen, a zero-width space or joiner, a direction mark, a
// NUL byte as UTF-16 text read as UTF-8 has between letters; <wbr> decodes to
// a zero-width space) and a quoted-printable soft line break (= then a line
// break) may sit anywhere in it. A line break itself may sit anywhere after
// the local part; inside the local part it ends it, since a line break before
// an address is common in a string. Each run of breaks reads one way only, so
// a long run cannot make the match backtrack without end.
const UNSEEN = String.raw`\p{Cf}|\0`;
const LINE_BREAK = String.raw`[\n\r\v\f\u0085\u2028\u2029]`;
const SOFT = String.raw`(?:${UNSEEN}|=(?:\r\n|\n|\r))`;
const GAP = `(?:${UNSEEN}|=?${LINE_BREAK})*`;
const BREAKS = new RegExp(`${UNSEEN}|=?${LINE_BREAK}`, 'gu');
const withoutBreaks = (s: string) => s.replace(BREAKS, '');
const CHAR = '[A-Za-z0-9._+-]';
const LABEL_CHAR = '[A-Za-z0-9_-]';
const spread = (domain: string) =>
  [...domain].map((c) => (c === '.' ? DOT : escapeRe(c))).join(GAP);

const DECODED_ADDRESS_SOURCE =
  `(?:"${CHAR}+"|${CHAR}(?:${SOFT}*${CHAR})*)${GAP}${AT}${GAP}` +
  `(?:${LABEL_CHAR}(?:${GAP}${LABEL_CHAR})*${GAP}${DOT}${GAP})*` +
  `(?:${CUSTOMER_DOMAINS.map(spread).join('|')})`;

/** An address at a customer domain or one of its subdomains, in the decoded line. */
const DECODED_ADDRESS = new RegExp(
  `${DECODED_ADDRESS_SOURCE}(?!${SOFT}*-?[A-Za-z0-9])(?!${SOFT}*${DOT}${SOFT}*[A-Za-z0-9-])`,
  'giu',
);

// In a folder or file name an address is found whatever follows it: a name
// has no prose to protect, and a suffix in it (-2026, _old, 2026, -backup)
// cannot be told from a longer domain, so a path fails closed. Same forms,
// with no tail.
const PATH_ADDRESS = new RegExp(ADDRESS_SOURCE, 'gi');
const PATH_DECODED_ADDRESS = new RegExp(DECODED_ADDRESS_SOURCE, 'giu');

/** The patterns one reading of a line, or of a name, is matched with. */
type Patterns = { written: RegExp; decoded: RegExp };
const IN_FILE: Patterns = { written: ADDRESS, decoded: DECODED_ADDRESS };
const IN_PATH: Patterns = { written: PATH_ADDRESS, decoded: PATH_DECODED_ADDRESS };

const AT_ANYWHERE = new RegExp(AT_SOURCE, 'gi');
const DOT_ANYWHERE = new RegExp(DOT_SOURCE, 'gi');

/** The address as the allowlist hashes it: lower case, no breaks or quotes, @ and dots plain. */
function normalise(raw: string): string {
  return withoutBreaks(raw)
    .toLowerCase()
    .replace(AT_ANYWHERE, '@')
    .replace(DOT_ANYWHERE, '.')
    .replace(/^"([^"]*)"@/, '$1@');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Named HTML references that can spell part of an address, wrap one or hide a
// break in one, looked up in lower case.
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  commat: '@',
  period: '.',
  lowbar: '_',
  underbar: '_',
  plus: '+',
  amp: '&',
  percnt: '%',
  bsol: '\\',
  equals: '=',
  num: '#',
  semi: ';',
  lt: '<',
  gt: '>',
  lsqb: '[',
  lbrack: '[',
  rsqb: ']',
  rbrack: ']',
  lpar: '(',
  rpar: ')',
  lcub: '{',
  lbrace: '{',
  rcub: '}',
  rbrace: '}',
  quot: '"',
  apos: "'",
  newline: '\n',
  tab: '\t',
  shy: '\u00AD',
  zerowidthspace: '\u200B',
  zwnj: '\u200C',
  zwj: '\u200D',
  lrm: '\u200E',
  rlm: '\u200F',
  nobreak: '\u2060',
};

const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
  v: '\v',
};

const fromCode = (whole: string, code: number) =>
  code <= 0x10ffff ? String.fromCodePoint(code) : whole;

/** One round of decoding. */
function decodeOnce(text: string): string {
  return (
    text
      // %uXXXX (JavaScript's escape()), then runs of %XX as UTF-8; a run that
      // is not UTF-8 has its ASCII bytes decoded and the rest left as written.
      .replace(/%[uU]([0-9A-Fa-f]{4})/g, (whole, hex: string) => fromCode(whole, parseInt(hex, 16)))
      .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run.replace(/%([0-7][0-9A-Fa-f])/g, (whole, hex: string) =>
            fromCode(whole, parseInt(hex, 16)),
          );
        }
      })
      // HTML references: numeric ones with or without the semicolon (as a
      // browser reads them), named ones with it.
      .replace(
        /&#(?:0*([0-9]{1,7})|[xX]0*([0-9A-Fa-f]{1,6}));?|&([A-Za-z]{2,31});/g,
        (whole, dec?: string, hex?: string, name?: string) => {
          if (name !== undefined) return NAMED_REFERENCES[name.toLowerCase()] ?? whole;
          return fromCode(whole, dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16));
        },
      )
      // SQL Unicode strings, U&'...' with \XXXX or \+XXXXXX (read before the
      // octal escapes below, which would read \0040 as \004 and a 0).
      .replace(/U&'(?:[^']|'')*'/gi, (literal) =>
        literal.replace(
          /\\(?:\+([0-9A-Fa-f]{6})|([0-9A-Fa-f]{4}))/g,
          (whole, six?: string, four?: string) => fromCode(whole, parseInt((six ?? four)!, 16)),
        ),
      )
      // Backslash escapes behind one backslash or more (a string inside a
      // string): \UXXXXXXXX, \u{X}, \uXXXX, \xXX, octal, \n \r \t \f \v, and a
      // backslash before any other mark.
      .replace(
        /\\+(?:U([0-9A-Fa-f]{8})|[uU]\{([0-9A-Fa-f]{1,6})\}|[uU]([0-9A-Fa-f]{4})|[xX]([0-9A-Fa-f]{2})|([0-3][0-7]{2})|([nrtfv])|([^\sA-Za-z0-9]))/g,
        (
          whole,
          long?: string,
          braced?: string,
          short?: string,
          byte?: string,
          octal?: string,
          control?: string,
          mark?: string,
        ) => {
          if (mark !== undefined) return mark;
          if (control !== undefined) return CONTROL_ESCAPES[control]!;
          if (octal !== undefined) return fromCode(whole, parseInt(octal, 8));
          return fromCode(whole, parseInt((long ?? braced ?? short ?? byte)!, 16));
        },
      )
      .replace(/<wbr\s*\/?>/gi, '\u200B')
      .replace(/<\/?br\s*\/?>/gi, '\n')
      // Full-width and other compatibility forms, then the full stops that
      // domain names also read as dots.
      .normalize('NFKC')
      .replace(/[\u3002\uFF0E\uFF61]/g, '.')
  );
}

/** The line decoded round after round until nothing changes (16 rounds at most). */
function decode(line: string): string {
  let text = line;
  for (let round = 0; round < 16; round += 1) {
    const next = decodeOnce(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

const BINARY_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|ico|icns|heic|pdf|woff2?|ttf|otf|eot|mp3|mp4|mov|webm|wav|zip|gz|tgz|br)$/i;

/** Whether the scan reads this tracked path at all. */
const isScannedPath = (file: string) =>
  !BINARY_EXTENSION.test(file) && !basename(file).startsWith('.env');

// Only text that names a domain's first label, as written or decoded, can
// hold an address there.
const HINT = new RegExp(CUSTOMER_DOMAINS.map((d) => escapeRe(d.split('.')[0]!)).join('|'), 'i');

/** An address in a file's line (from 1), or in its path (line 0). */
type Found = { file: string; line: number; sha256: string; domain: string };

/**
 * Every address on each line, as written and decoded, once per line and
 * address: with the file patterns, or each name of a path with the path ones.
 */
function findIn(file: string, text: string, patterns: Patterns = IN_FILE): Found[] {
  const found: Found[] = [];
  text.split('\n').forEach((content, i) => {
    const decoded = decode(content);
    if (!HINT.test(content) && !HINT.test(withoutBreaks(decoded))) return;
    const seen = new Set<string>();
    const add = (match: string) => {
      const address = normalise(match);
      if (seen.has(address)) return;
      seen.add(address);
      found.push({
        file,
        line: i + 1,
        sha256: sha256(address),
        domain: address.slice(address.indexOf('@') + 1),
      });
    };
    for (const match of content.matchAll(patterns.written)) add(match[0]);
    for (const match of decoded.matchAll(patterns.decoded)) add(match[0]);
  });
  return found;
}

/**
 * A file's texts: its bytes as UTF-8 (NUL bytes and all) and, behind a
 * byte-order mark, as UTF-16 too. The mark is not trusted on its own, since
 * 8-bit text can follow one.
 */
function textsOf(bytes: Buffer): string[] {
  const texts = [bytes.toString('utf8')];
  if (bytes[0] === 0xff && bytes[1] === 0xfe) texts.push(bytes.subarray(2).toString('utf16le'));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    texts.push(
      Buffer.from(bytes.subarray(2, bytes.length - (bytes.length % 2)))
        .swap16()
        .toString('utf16le'),
    );
  }
  return texts;
}

/**
 * Every finding in one tracked file's bytes, in each of its texts, once per
 * line and address. Each line is decoded by itself, with no filter on the
 * whole file first: decoded whole, a U& string left open on one line would
 * run into the next and hide its escapes.
 */
function findInFile(file: string, bytes: Buffer): Found[] {
  const seen = new Set<string>();
  return textsOf(bytes)
    .flatMap((text) => findIn(file, text))
    .filter((f) => {
      const key = `${f.line} ${f.sha256}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Each folder and file name in a path, as written and with its extensions
 * taken off one at a time (report.csv.gz, report.csv, report). With no tail
 * on the path patterns the whole name already finds what a shorter reading
 * does; the shorter readings stay as a second way in.
 */
function pathReadings(file: string): string[] {
  return file.split('/').flatMap((name) => {
    const readings = [name];
    for (let dot = name.lastIndexOf('.'); dot > 0; dot = name.lastIndexOf('.', dot - 1)) {
      readings.push(name.slice(0, dot));
    }
    return readings;
  });
}

/**
 * Every address in a tracked path itself, and in the path a symbolic link
 * points to (`target`), whatever follows it in a name, once each, as line 0.
 */
function findInPath(file: string, target?: string): Found[] {
  const seen = new Set<string>();
  const names = target === undefined ? [file] : [file, target];
  return findIn(file, names.flatMap(pathReadings).join('\n'), IN_PATH).flatMap((f) => {
    if (seen.has(f.sha256)) return [];
    seen.add(f.sha256);
    return [{ ...f, line: 0 }];
  });
}

/**
 * Every finding in the listed paths, and in the files the scan reads. `read`
 * gives a file's bytes (undefined: not on disk), and `linkTarget` the path a
 * symbolic link points to (undefined: not a link). Every path is read, even
 * where its contents are not: a name is as public as a file. A link is read as
 * the path it points to, whatever its own name, and never followed.
 */
function scanFiles(
  files: readonly string[],
  read: (file: string) => Buffer | undefined,
  linkTarget: (file: string) => string | undefined = () => undefined,
): Found[] {
  const found: Found[] = [];
  for (const file of files) {
    const target = linkTarget(file);
    found.push(...findInPath(file, target));
    if (target !== undefined || !isScannedPath(file)) continue;
    const bytes = read(file);
    if (bytes) found.push(...findInFile(file, bytes));
  }
  return found;
}

/**
 * Every finding in the checkout at `root`, over each path git tracks there
 * (`git ls-files --stage`). A symbolic link is never followed: git holds it as
 * a blob (mode 120000) whose text is the path it points to, and publishes that
 * text, so that path is what is read, from the link itself or, when the
 * checkout holds the link as a plain file (core.symlinks false), from git's
 * blob. Any other path is a file whose bytes are read. Git runs with `env`.
 */
function scanCheckout(root: string, env: NodeJS.ProcessEnv = process.env): Found[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Each tracked path once, with its blob when git holds it as a link. Each
  // record is "<mode> <object> <stage>\t<path>".
  const tracked = new Map<string, string | undefined>();
  for (const record of git('ls-files', '--stage', '-z').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, object] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (mode === '120000') tracked.set(file, object);
    else if (!tracked.has(file)) tracked.set(file, undefined);
  }
  return scanFiles(
    [...tracked.keys()],
    (file) => {
      try {
        return readFileSync(join(root, file));
      } catch {
        return undefined; // listed but not on disk (deleted in a working tree)
      }
    },
    (file) => {
      const path = join(root, file);
      try {
        if (lstatSync(path).isSymbolicLink()) return readlinkSync(path);
      } catch {
        // not on disk; a link git holds is still read from its blob
      }
      const blob = tracked.get(file);
      return blob === undefined ? undefined : git('cat-file', 'blob', blob);
    },
  );
}

let scanned: Found[] | undefined;

const scanTrackedTree = (): Found[] => (scanned ??= scanCheckout(REPO_ROOT));

type Spelling = [name: string, text: string, finds: readonly string[]];

/**
 * Each spelling, at every customer domain, whose findings are not exactly its
 * addresses in order: its name, the domain's place in the list and what was
 * found instead (never the domain itself, so a failing run prints none).
 */
function misses(spellingsAt: (domain: string, parts: [string, string]) => Spelling[]): string[] {
  const missed: string[] = [];
  CUSTOMER_DOMAINS.forEach((domain, i) => {
    const parts = domain.split('.') as [string, string];
    for (const [name, text, finds] of spellingsAt(domain, parts)) {
      const found = findIn('sample.txt', text).map((f) => f.sha256);
      const expected = finds.map(sha256);
      if (found.join(' ') === expected.join(' ')) continue;
      const what =
        found.length === 0
          ? 'no finding'
          : found.length === expected.length
            ? 'another address'
            : `${found.length} findings, ${expected.length} expected`;
      missed.push(`${name} (domain ${i + 1}): ${what}`);
    }
  });
  return missed;
}

describe("the tracked tree holds no address at the customer's mail domains", () => {
  it('finds none outside the allowed (file, address) pairs', () => {
    const unexpected = scanTrackedTree()
      .filter((f) => !ALLOWED.some((a) => a.file === f.file && a.sha256 === f.sha256))
      .map((f) => `${f.file}:${f.line || 'path'} (an address at ${f.domain})`);
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

  // The spellings below are built at run time from the domains, which
  // customer-identity.ts joins from pieces, and a miss is reported by its name
  // and the domain's place in the list, so a failing run prints no domain.
  it('finds each spelling of an address as written', () => {
    expect(
      misses((domain, [label, tld]) => {
        const plain = `intake@${domain}`;
        return [
          ['plain', plain, [plain]],
          ['upper case in a sentence', `Reach ${plain.toUpperCase()} today`, [plain]],
          ['a mailto link', `mailto:${plain}?subject=Hello`, [plain]],
          ['@ as %40', `intake%40${domain}`, [plain]],
          ['@ as %2540', `intake%2540${domain}`, [plain]],
          ['@ as &#64;', `intake&#64;${domain}`, [plain]],
          ['@ as \\u0040', String.raw`intake\u0040${domain}`, [plain]],
          ['@ as \\x40', String.raw`intake\x40${domain}`, [plain]],
          ['under a subdomain', `intake@mail.${domain}`, [`intake@mail.${domain}`]],
          ['in a regular expression', String.raw`/^intake@${label}\.${tld}$/`, [plain]],
          ['in a string holding one', String.raw`'intake@${label}\\.${tld}'`, [plain]],
          ['ending a sentence', `Write to ${plain}.`, [plain]],
          // An Outlook compose link: the name-addr form, encoded twice.
          [
            'an Outlook compose link',
            `mailtouri=mailto%3AFront%2520Desk%2520%253Cintake%2540${domain}%253E`,
            [plain],
          ],
          // Two encoded addresses in one link are two findings, each hashed as itself.
          [
            'two addresses in one link',
            `mailto%3Aintake%2540${domain}%3Fcc%3Dlead%2540${domain}%26subject%3DHello`,
            [plain, `lead@${domain}`],
          ],
          ['@ behind two backslashes', String.raw`intake\\@${domain}`, [plain]],
          ['@ in a character class', `intake[@]${domain}`, [plain]],
          ['@ and dots in brackets', `intake(@)${label}(.)${tld}`, [plain]],
          ['@ and dots as bracketed words', `intake [at] ${label} [dot] ${tld}`, [plain]],
          ['@ and dot as quoted-printable', `intake=40${label}=2E${tld}`, [plain]],
          ['a dot behind three backslashes', String.raw`intake@${label}\\\.${tld}`, [plain]],
          ['a dot in a character class', `intake@${label}[.]${tld}`, [plain]],
          ['a dot as %2E', `intake@${label}%2E${tld}`, [plain]],
          ['a dot as &#46;', `intake@${label}&#46;${tld}`, [plain]],
          ['a dot as &period;', `intake@${label}&period;${tld}`, [plain]],
          ['a dot as \\u002e', String.raw`intake@${label}\u002e${tld}`, [plain]],
          ['a dot as \\x2e', String.raw`intake@${label}\x2e${tld}`, [plain]],
          ['a subdomain dot as %2E', `intake@mail%2E${domain}`, [`intake@mail.${domain}`]],
          [
            'a subdomain with an underscore',
            `intake@mail_1.${domain}`,
            [`intake@mail_1.${domain}`],
          ],
          ['a quoted local part', `"intake"@${domain}`, [plain]],
          ['upper-case escapes', `INTAKE%40${label.toUpperCase()}%2E${tld.toUpperCase()}`, [plain]],
          ['followed by a double-hyphen dash', `Write to ${plain}--they reply.`, [plain]],
          ['followed by a hyphen', `${plain}- the intake box`, [plain]],
        ];
      }),
    ).toEqual([]);
  });

  // The integrator's regression spellings (2026-10-26): a guard that protects a
  // public repository fails closed, so the line is also read decoded.
  it('finds each spelling of an address in the decoded line', () => {
    expect(
      misses((domain, [label, tld]) => {
        const plain = `intake@${domain}`;
        const charCode = (c: string) => c.charCodeAt(0);
        const hex = (c: string) => charCode(c).toString(16).toUpperCase().padStart(2, '0');
        const first = label[0]!;
        const rest = label.slice(1);
        return [
          ['a fully %-encoded local part', `%69%6E%74%61%6B%65%40${domain}`, [plain]],
          ['one character right after %25', `%25a%40${domain}`, [`a@${domain}`]],
          ['two characters right after %25', `%25ab%40${domain}`, [`ab@${domain}`]],
          ['a literal % before a short local part', `100%ab@${domain}`, [`ab@${domain}`]],
          ['an encoded < before a one-letter local part', `%3Ca%40${domain}`, [`a@${domain}`]],
          [
            'the whole address as HTML references',
            [...plain].map((c) => `&#${charCode(c)};`).join(''),
            [plain],
          ],
          [
            'the whole address as \\u escapes',
            [...plain].map((c) => `\\u00${hex(c)}`).join(''),
            [plain],
          ],
          [
            'the whole address as \\x escapes',
            [...plain].map((c) => `\\x${hex(c)}`).join(''),
            [plain],
          ],
          ['a domain letter %-encoded', `intake@%${hex(first)}${rest}.${tld}`, [plain]],
          ['a domain letter as a reference', `intake@&#${charCode(first)};${rest}.${tld}`, [plain]],
          ['a domain letter as \\x', `intake@\\x${hex(first)}${rest}.${tld}`, [plain]],
          ['@ as &#64 with no semicolon', `intake&#64${domain}`, [plain]],
          ['@ as \\u0040 behind three backslashes', `intake\\\\\\u0040${domain}`, [plain]],
          ['@ as an octal escape', `intake\\100${domain}`, [plain]],
          ['@ as \\U00000040', `intake\\U00000040${domain}`, [plain]],
          ['@ as %u0040', `intake%u0040${domain}`, [plain]],
          ['@ as %U0040, all in upper case', `INTAKE%U0040${domain.toUpperCase()}`, [plain]],
          ['a dot as an octal escape', `intake@${label}\\056${tld}`, [plain]],
          ['@ in a SQL Unicode string', `U&'intake\\0040${domain}'`, [plain]],
          ['@ in a SQL Unicode string, six digits', `u&'intake\\+000040${domain}'`, [plain]],
          ['a %-encoded HTML reference', `intake%26%2364%3B${domain}`, [plain]],
          ['an HTML-encoded %40', `intake&#37;40${domain}`, [plain]],
          ['a \\u-escaped %40', `intake\\u002540${domain}`, [plain]],
          ['a %-encoded \\u escape', `intake%5Cu0040${domain}`, [plain]],
          ['an HTML reference encoded twice', `intake&amp;#64;${domain}`, [plain]],
          // Each of these needs a round per layer: three, three, then the most
          // the decoded reading takes (16).
          [
            'a domain letter %-encoded three times',
            `intake@%2525${hex(first)}${rest}.${tld}`,
            [plain],
          ],
          [
            'an HTML-encoded %-escape, encoded again',
            `intake@&amp;#37;${hex(first)}${rest}.${tld}`,
            [plain],
          ],
          [
            'a domain letter %-encoded sixteen times',
            `intake@%${'25'.repeat(15)}${hex(first)}${rest}.${tld}`,
            [plain],
          ],
          [
            'full-width letters',
            [...plain].map((c) => String.fromCharCode(charCode(c) + 0xfee0)).join(''),
            [plain],
          ],
          ['an ideographic full stop', `intake@${label}\u3002${tld}`, [plain]],
          // A local part partly encoded: the decoded line gives the address, and
          // the line as written gives the part after the escape (both fail).
          ['a partly encoded local part', `%69ntake%40${domain}`, [`ntake@${domain}`, plain]],
        ];
      }),
    ).toEqual([]);
  });

  it('finds an address broken by a line break or an invisible break within one line', () => {
    expect(
      misses((domain, [label, tld]) => {
        const plain = `intake@${domain}`;
        const head = label.slice(0, 2);
        const tail = label.slice(2);
        return [
          ['an escaped line break before it', String.raw`Dear team,\n${plain}`, [plain]],
          ['an escaped tab before it', String.raw`To:\t${plain}`, [plain]],
          ['an escaped line break before the @', String.raw`intake\n@${domain}`, [plain]],
          ['an escaped line break after the @', String.raw`intake@\n${domain}`, [plain]],
          ['an escaped CRLF in the domain', String.raw`intake@${head}\r\n${tail}.${tld}`, [plain]],
          ['a %-encoded line break after a dot', `intake@${label}.%0A${tld}`, [plain]],
          ['a line break reference after the @', `intake@&#10;${domain}`, [plain]],
          ['<br> after the @', `intake@<br>${domain}`, [plain]],
          ['a line separator after the @', `intake@\u2028${domain}`, [plain]],
          ['&shy; in the domain', `intake@${head}&shy;${tail}.${tld}`, [plain]],
          ['a soft hyphen in the domain', `intake@${head}\u00AD${tail}.${tld}`, [plain]],
          ['<wbr> in the domain', `intake@${head}<wbr>${tail}.${tld}`, [plain]],
          ['an escaped zero-width space', String.raw`intake@${head}\u200B${tail}.${tld}`, [plain]],
          ['a quoted-printable soft break', String.raw`intake@${head}=\r\n${tail}.${tld}`, [plain]],
          // As written, a local part starts after the reference (both fail).
          ['&shy; in the local part', `in&shy;take@${domain}`, [`take@${domain}`, plain]],
        ];
      }),
    ).toEqual([]);
  });

  it('leaves lookalikes alone', () => {
    expect(
      misses((domain, [label, tld]) => [
        ['a web link', `https://www.${domain}/`, []],
        ['the first label alone', `the ${label} portal`, []],
        ['a longer first label', `intake@not${domain}`, []],
        ['a longer domain', `intake@${domain}.example`, []],
        ['a longer last label', `intake@${label}.${tld}x`, []],
        ['a hyphenated lookalike', `intake@${label}-${tld}.test`, []],
        ['a longer domain, encoded', `intake%40${domain}%2Eexample`, []],
        ['a hyphenated longer domain', `intake@${domain}-mail.example`, []],
        ['the domain in prose', `the team at ${domain}`, []],
        ['a bracketed word in prose', `intake (at) the ${domain} office`, []],
        // The synthetic stand-ins are no customer domain.
        ['the stand-ins', 'dc4@sampleorg.test cc jstone@site1.test, pat@example.org', []],
      ]),
    ).toEqual([]);
  });

  it('reads a long run of breaks after an @ in one pass', () => {
    // Each break reads one way only; a run that could read two ways made the
    // match backtrack twice as long for each break.
    const breaks = String.raw`=\r\n`.repeat(5_000);
    for (const domain of CUSTOMER_DOMAINS) {
      expect(findIn('sample.txt', `intake@${breaks}x ${domain}`)).toEqual([]);
      expect(findIn('sample.txt', `intake@${breaks}${domain}`)).toHaveLength(1);
    }
  });

  it('reads each line of a file by itself, as UTF-8 and as UTF-16 behind a byte-order mark', () => {
    const missed: string[] = [];
    CUSTOMER_DOMAINS.forEach((domain, i) => {
      const [label, tld] = domain.split('.') as [string, string];
      const plain = `intake@${domain}`;
      const first = label[0]!.charCodeAt(0).toString(16).toUpperCase();
      const files: [string, Buffer][] = [
        ['a %-encoded first letter', Buffer.from(`intake@%${first}${label.slice(1)}.${tld}\n`)],
        [
          'soft hyphens in the first label',
          Buffer.from(`intake@${label.split('').join('&shy;')}.${tld}\n`),
        ],
        ['UTF-16LE with a byte-order mark', Buffer.from(`\uFEFF${plain}\n`, 'utf16le')],
        ['UTF-16BE with a byte-order mark', Buffer.from(`\uFEFF${plain}\n`, 'utf16le').swap16()],
        ['UTF-16LE with no byte-order mark', Buffer.from(`Write to ${plain}\n`, 'utf16le')],
        ['NUL bytes before it', Buffer.concat([Buffer.from([0, 1, 2, 0, 10]), Buffer.from(plain)])],
        // Each line is read by itself: a U& string left open on an earlier
        // line does not run into a later one and hide its escapes.
        [
          "a SQL Unicode escape after an unclosed U&' line",
          Buffer.from(`-- U&'x\nU&'intake@\\${first.padStart(4, '0')}${label.slice(1)}.${tld}'\n`),
        ],
        // A byte-order mark is not trusted: what follows it is read as UTF-8 too.
        [
          'FF FE, then 8-bit text',
          Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`Write to ${plain}\n`)]),
        ],
        [
          'FE FF, then a CSV in 8-bit text',
          Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`id,email\n1,${plain}\n`)]),
        ],
        [
          'UTF-16LE with a byte-order mark, then UTF-8 appended',
          Buffer.concat([Buffer.from('\uFEFFWrite to us\n', 'utf16le'), Buffer.from(`${plain}\n`)]),
        ],
      ];
      for (const [name, bytes] of files) {
        const found = findInFile('sample.txt', bytes).map((f) => f.sha256);
        if (found.join(' ') !== sha256(plain)) {
          missed.push(`${name} (domain ${i + 1}): ${found.length} findings`);
        }
      }
    });
    expect(missed).toEqual([]);
  });

  it('reads every tracked path, folder and file names included', () => {
    const missed: string[] = [];
    CUSTOMER_DOMAINS.forEach((domain, i) => {
      const plain = `intake@${domain}`;
      const paths: [name: string, path: string, finds: readonly string[]][] = [
        ['a folder named after it', `exports/${plain}/report.csv`, [plain]],
        ['a file named after it', `exports/${plain}.csv`, [plain]],
        ['a file name holding it', `exports/report-${plain}.csv`, [`report-${plain}`]],
        ['a file with two extensions', `exports/${plain}.csv.gz`, [plain]],
        ['a folder with an extension', `exports/${plain}.d/report.csv`, [plain]],
        ['a folder and its file both named after it', `exports/${plain}/${plain}.csv`, [plain]],
        ['an encoded @ in a file name', `exports/intake%40${domain}.csv`, [plain]],
        // Names are read even where the contents are not.
        ['a file whose contents are skipped', `assets/${plain}.png`, [plain]],
        ['a folder holding a .env file', `config/${plain}/.env.local`, [plain]],
        ['the domain alone as a folder', `docs/${domain}/notes.md`, []],
        ['a longer first label in a folder name', `exports/intake@not${domain}/report.csv`, []],
      ];
      for (const [name, path, finds] of paths) {
        const found = scanFiles([path], () => Buffer.from('id,total\n1,10\n'));
        const expected = finds.map((address) => `0 ${sha256(address)}`);
        if (found.map((f) => `${f.line} ${f.sha256}`).join(' ') !== expected.join(' ')) {
          missed.push(`${name} (domain ${i + 1}): ${found.length} findings`);
        }
      }
    });
    expect(missed).toEqual([]);
  });

  // The integrator's path cases (2026-10-26): a name has no prose to protect,
  // and a suffix in it cannot be told from a longer domain, so an address in a
  // name is a finding whatever follows it.
  it('finds an address in a folder or file name whatever follows it', () => {
    const missed: string[] = [];
    const encodedLocal = [...'intake']
      .map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      .join('');
    CUSTOMER_DOMAINS.forEach((domain, i) => {
      const plain = `intake@${domain}`;
      for (const [spelled, written, readAlone] of [
        ['@', plain, ['as written', 'decoded']],
        ['%40', `intake%40${domain}`, ['as written', 'decoded']],
        // As written a local part never starts inside an escape, so only the
        // decoded reading finds this one.
        ['%40 after a %-encoded local part', `${encodedLocal}%40${domain}`, ['decoded']],
      ] as const) {
        const paths: [name: string, path: string, finds: string][] = [
          ['a dash and a year after it', `${written}-2026.csv`, plain],
          ['a dash and a word after it, in a folder name', `${written}-backup/report.csv`, plain],
          ['an underscore and a word after it', `${written}_old.csv`, plain],
          ['digits right after it', `${written}2026.csv`, plain],
          ['a dash, a version and two extensions after it', `${written}-v2.tar.gz`, plain],
          ['a word and a dash before it', `report-${written}.csv`, `report-${plain}`],
          ['a letter right after it', `${written}x.csv`, plain],
        ];
        for (const [name, path, finds] of paths) {
          const found = scanFiles([path], () => Buffer.from('id,total\n1,10\n'));
          if (found.map((f) => `${f.line} ${f.sha256}`).join(' ') !== `0 ${sha256(finds)}`) {
            missed.push(`${name}, @ as ${spelled} (domain ${i + 1}): ${found.length} findings`);
          }
          // Each reading that can find it finds it on its own, so neither leans
          // on the other.
          for (const [reading, pattern, text] of [
            ['as written', IN_PATH.written, path],
            ['decoded', IN_PATH.decoded, decode(path)],
          ] as const) {
            if (!(readAlone as readonly string[]).includes(reading)) continue;
            const alone = [...text.matchAll(pattern)].map((m) => sha256(normalise(m[0])));
            if (alone.join(' ') !== sha256(finds)) {
              missed.push(
                `${name}, @ as ${spelled}, read ${reading} alone (domain ${i + 1}): ${alone.length} matches`,
              );
            }
          }
        }
      }
    });
    expect(missed).toEqual([]);
  });

  // The security review's link cases (2026-10-27): git holds a symbolic link
  // as a blob whose text is the path it points to, and publishes that text, so
  // the scan reads it as a path. Following the link instead reads nothing for
  // a dangling one and, for a live one, a file that may be outside the
  // checkout or a .env file.
  it('reads a symbolic link as the path it points to, and never follows it', () => {
    const root = mkdtempSync(join(tmpdir(), 'address-guard-'));
    const checkout = join(root, 'checkout');
    const outside = join(root, 'outside');
    // No variable a git hook sets (GIT_DIR, GIT_INDEX_FILE, ...) may point
    // these runs at another repository.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: checkout, env, encoding: 'utf8', stdio: 'pipe' }).trim();
    type Case = { name: string; path: string; line: number; finds: readonly string[]; at: number };
    const cases: Case[] = [];
    const plainFiles: string[] = [];
    const swaps: [path: string, target: string][] = [];
    try {
      mkdirSync(checkout);
      git('init', '-q');
      CUSTOMER_DOMAINS.forEach((domain, i) => {
        const plain = `intake@${domain}`;
        const dir = `d${i + 1}`;
        mkdirSync(join(checkout, dir));
        mkdirSync(join(outside, dir), { recursive: true });
        writeFileSync(join(outside, dir, `${plain}.txt`), 'id,total\n1,10\n');
        writeFileSync(join(outside, dir, 'contacts.csv'), `id,email\n1,${plain}\n`);
        writeFileSync(join(outside, dir, '.env.local'), `CONTACT=${plain}\n`);
        const add = (name: string, path: string, line: number, finds: readonly string[]) =>
          cases.push({ name, path: `${dir}/${path}`, line, finds, at: i + 1 });
        const link = (name: string, path: string, target: string, finds: readonly string[]) => {
          symlinkSync(target, join(checkout, dir, path));
          add(name, path, 0, finds);
        };
        link('a dangling link to a dated file', 'latest.csv', `../archive/${plain}-2026.csv`, [
          plain,
        ]);
        link('a dangling link to the address alone', 'inbox', plain, [plain]);
        link(
          'a live link to a file outside named after it',
          'report.txt',
          `../../outside/${dir}/${plain}.txt`,
          [plain],
        );
        link('a link whose contents the scan skips', 'logo.png', `${plain}.png`, [plain]);
        link('a link named .env.local', '.env.local', `../${plain}/.env`, [plain]);
        link('a link named after it, to a name holding it', `${plain}-link`, `${plain}.csv`, [
          plain,
        ]);
        // Never followed: what a live link points to is not read.
        link(
          'a live link to a file outside holding it',
          'contacts.csv',
          `../../outside/${dir}/contacts.csv`,
          [],
        );
        link(
          'a live link to a .env file outside holding it',
          'settings.txt',
          `../../outside/${dir}/.env.local`,
          [],
        );
        link('a link to a longer first label', 'lookalike.csv', `intake@not${domain}.csv`, []);
        // With core.symlinks false git checks a link out as a plain file that
        // holds the path, and git still holds it as a link.
        writeFileSync(join(checkout, dir, 'plain-link.csv'), `../archive/${plain}-2026.csv`);
        plainFiles.push(`${dir}/plain-link.csv`);
        add('a link checked out as a plain file', 'plain-link.csv', 0, [plain]);
        // A link not yet staged, in place of a tracked file, is not followed either.
        writeFileSync(join(checkout, dir, 'swapped.csv'), 'id,total\n1,10\n');
        swaps.push([`${dir}/swapped.csv`, `../archive/${plain}-2026.csv`]);
        add('a link not yet staged, in place of a tracked file', 'swapped.csv', 0, [plain]);
        // Files are read as before.
        writeFileSync(join(checkout, dir, `${plain}-2026.csv`), 'id,total\n1,10\n');
        add('a file named after it', `${plain}-2026.csv`, 0, [plain]);
        writeFileSync(join(checkout, dir, 'orders.csv'), `id,email\n1,${plain}\n`);
        add('a file holding it', 'orders.csv', 2, [plain]);
      });
      git('add', '-f', '--', ...cases.map((c) => c.path));
      for (const file of plainFiles) {
        git(
          'update-index',
          '--cacheinfo',
          `120000,${git('hash-object', '-w', '--', file)},${file}`,
        );
      }
      for (const [file, target] of swaps) {
        rmSync(join(checkout, file));
        symlinkSync(target, join(checkout, file));
      }
      expect(git('ls-files', '-s', '--', 'd1/plain-link.csv')).toMatch(/^120000 /);
      expect(git('ls-files', '-s', '--', 'd1/latest.csv')).toMatch(/^120000 /);
      expect(git('ls-files', '-s', '--', 'd1/swapped.csv')).toMatch(/^100644 /);

      const found = scanCheckout(checkout, env);
      const missed = cases.flatMap((c) => {
        const got = found.filter((f) => f.file === c.path).map((f) => `${f.line} ${f.sha256}`);
        const expected = c.finds.map((address) => `${c.line} ${sha256(address)}`);
        return got.join(' ') === expected.join(' ')
          ? []
          : [`${c.name} (domain ${c.at}): ${got.length} findings`];
      });
      expect(missed).toEqual([]);
      expect(found.filter((f) => !cases.some((c) => c.path === f.file))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
