import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type Copy, copyInSource } from './copy-in-source';
import { CUSTOMER_DOMAINS, CUSTOMER_NAMES } from './customer-identity';

/**
 * No customer name in the copy people see (docket S17, 2026-10-31).
 *
 * WHAT WAS THERE: example text and placeholders named the customer: the phone
 * AI screen's example questions, the PO name, schedule event and count notes
 * placeholders on the web and the phone, the landing page and the sign-in
 * panel, a published What's New example and the email registry's sample
 * values. Every organization's members saw most of them, and the repository
 * is public. Each is generic now.
 *
 * WHAT STOPS IT NOW: this test lists every tracked .ts and .tsx file of the
 * screens and the code they share (apps/web/src, apps/mobile/app,
 * apps/mobile/src, packages/<name>/src, and apps/mobile/app.config.ts, whose
 * strings iOS and the App Store show), tests, mocks and fixtures left out, and
 * reads its copy: string and template literals, JSX attribute values and the
 * text of each JSX element with its children joined (test/copy-in-source.ts,
 * the reader the on-record wording guard uses too). It fails on any of the
 * customer's names (test/customer-identity.ts), in any case, with nothing, a
 * space, a hyphen, an underscore, a dot or a middle dot between its pieces,
 * after compatibility forms are folded (NFKC), and with no letter or digit on
 * either side. A JSX element is not reported for a name already reported
 * inside it (in a child element, or a literal among its children); a literal
 * is always reported.
 *
 * A failure names the file, the line and the name's place in the list, never
 * the name or the text: the logs of a public repository are public too. The
 * only copy allowed is the (file, text) pairs in ALLOWED, each with its
 * reason, held as sha256 of the text (compatibility forms folded, lower case,
 * white space collapsed), so this file names none of it. An allowed pair that
 * is no longer in its file fails too, so the list cannot outlive its reason.
 *
 * NOT COVERED: comments, identifiers, regular expression literals and import
 * paths; JSON, Markdown, CSV, CSS and every other kind of file; tests, mocks,
 * fixtures, scripts, docs and migrations (the customer's names stay there
 * until the repository's own question, O19, is settled;
 * customer-addresses.guard.test.ts reads all of them for addresses); images;
 * a name that comes from data or is put together at run time; a name split by
 * markup or by other characters; and a name in lookalike letters from another
 * script, written with escapes, or in another encoding. Git history keeps the
 * old copy.
 *
 * IF THIS FAILS: write a generic example instead (Main Warehouse, Sample Org,
 * Charter A). Add a pair to ALLOWED only for text that members are never
 * shown and the product needs as it is, with the reason on its line.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

type Allowed = { file: string; sha256: string; why: string };

const ALLOWED: readonly Allowed[] = [
  {
    file: 'packages/core/src/maintenance/constants.ts',
    sha256: 'dcc90e29c5b97495ad95f1756106c66ea5a23719e487f2b96cda84d3826b98a9',
    why: "the compiled sample recipient's address (synthetic since S15): only the fallback reaches it, when the 0337 column is missing, which no database has, and the tests share it",
  },
  {
    file: 'packages/core/src/maintenance/constants.ts',
    sha256: '2183faf8d13375e43f8de2778f94b22519dd23595aa23fc89c0b6346db79d5c7',
    why: "the compiled sample recipient's display name: the same fallback and the same tests as its address",
  },
  {
    file: 'packages/core/src/orders/delivery-request-recipients.ts',
    sha256: 'dcc90e29c5b97495ad95f1756106c66ea5a23719e487f2b96cda84d3826b98a9',
    why: "the delivery twin of the sample recipient's address: the same fallback (no 0337 column) and the same tests",
  },
  {
    file: 'packages/core/src/orders/delivery-request-recipients.ts',
    sha256: '2183faf8d13375e43f8de2778f94b22519dd23595aa23fc89c0b6346db79d5c7',
    why: "the delivery twin of the sample recipient's display name: the same fallback and the same tests",
  },
  {
    file: 'apps/web/src/server/actions/delivery-request.ts',
    sha256: 'e045115eaebeabba999e1d5bf89f63f6e14d837f67d01ec2e5ba1962dc194dfb',
    why: "the delivery-request audit label kept in audit_logs: renaming it would split the audit history, and only the platform admin's raw event view prints it",
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Between two pieces of a name: nothing, or a run of white space, hyphens,
// underscores, dots and middle dots.
const SEPARATOR = String.raw`[\s\-_.\u00B7]*`;

/**
 * Each name as one pattern: all of its pieces in order (none optional, so the
 * full name's first piece, a common verb, is never a match on its own), with
 * no letter or digit on either side, in any case.
 */
const NAME_PATTERNS: readonly RegExp[] = CUSTOMER_NAMES.map(
  (pieces) =>
    new RegExp(
      String.raw`(?<![\p{L}\p{N}])${pieces.map(escapeRe).join(SEPARATOR)}(?![\p{L}\p{N}])`,
      'iu',
    ),
);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The copy as ALLOWED holds it: compatibility forms folded, lower case, white space collapsed. */
const hashOf = (text: string) =>
  sha256(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());

/** A name in a file's copy: its line, its place in CUSTOMER_NAMES (from 1) and the copy's hash. */
type Found = { file: string; line: number; name: number; sha256: string };

/**
 * Every customer name in one file's copy, once per line, name and text. A JSX
 * element's text holds its children's, so its hit is dropped when a hit for
 * the same name lies inside its children (a child element, or a literal
 * among them), unless that hit is allowed: an allowed literal never hides the
 * element around it. Nothing else is dropped, and never by comparing texts,
 * so a literal is always reported, whatever other literal holds the same name.
 */
function findIn(file: string, text: string, allowed: readonly Allowed[] = ALLOWED): Found[] {
  const isAllowed = (hash: string) => allowed.some((a) => a.file === file && a.sha256 === hash);
  const hits: { copy: Copy; name: number; sha256: string }[] = [];
  for (const copy of copyInSource(file, text)) {
    const folded = copy.text.normalize('NFKC');
    NAME_PATTERNS.forEach((pattern, i) => {
      if (pattern.test(folded)) hits.push({ copy, name: i + 1, sha256: hashOf(copy.text) });
    });
  }
  const reported = hits.filter(
    (hit) =>
      !hit.copy.jsx ||
      !hits.some(
        (inner) =>
          inner !== hit &&
          inner.name === hit.name &&
          inner.copy.start >= hit.copy.start &&
          inner.copy.end <= hit.copy.end &&
          !isAllowed(inner.sha256),
      ),
  );
  const seen = new Set<string>();
  return reported.flatMap(({ copy, name, sha256: hash }) => {
    const key = `${copy.line} ${name} ${hash}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ file, line: copy.line, name, sha256: hash }];
  });
}

// Only a file whose text holds the first piece of a name (in any case,
// compatibility forms folded) can hold that name; no other file is parsed.
const FIRST_PIECES = [...new Set(CUSTOMER_NAMES.map((pieces) => pieces[0]!))];
const mayHoldAName = (text: string) => {
  const folded = text.normalize('NFKC').toLowerCase();
  return FIRST_PIECES.some((piece) => folded.includes(piece));
};

// The screens and the code they share, and the phone's app config by name: its
// app name and permission strings are shown by iOS and the App Store.
const SOURCE_ROOTS = ['apps/web/src/', 'apps/mobile/app/', 'apps/mobile/src/'];
const PACKAGE_SOURCE = /^packages\/[^/]+\/src\//;
const BY_NAME = ['apps/mobile/app.config.ts'];

/** Whether a tracked path is a source file whose copy this guard reads. */
function isCopyFile(file: string): boolean {
  if (BY_NAME.includes(file)) return true;
  if (!SOURCE_ROOTS.some((root) => file.startsWith(root)) && !PACKAGE_SOURCE.test(file)) {
    return false;
  }
  const name = basename(file);
  return (
    /\.tsx?$/.test(name) &&
    !name.endsWith('.d.ts') &&
    !/\.(?:test|spec)\./.test(name) &&
    !name.endsWith('.fixture.ts') &&
    !/(?:^|\/)__(?:mocks|fixtures)__\//.test(file) &&
    !file.startsWith('apps/web/src/test/')
  );
}

/**
 * The files whose copy is read, from `git ls-files --stage -z`, each record
 * "<mode> <object> <stage>\t<path>". Only a regular file (mode 100644 or
 * 100755) holds copy; a symbolic link (120000) holds a path and is skipped.
 */
function copyFiles(records: string): string[] {
  const files = new Set<string>();
  for (const record of records.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if ((mode === '100644' || mode === '100755') && isCopyFile(file)) files.add(file);
  }
  return [...files];
}

const listTracked = (root: string) =>
  execFileSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * Every customer name in the copy of the checkout at `root`. Files are read
 * from disk; one that is listed but not on disk, or is a link there, is
 * skipped.
 */
function scanCheckout(root: string): Found[] {
  const found: Found[] = [];
  for (const file of copyFiles(listTracked(root))) {
    const path = join(root, file);
    let text: string;
    try {
      if (lstatSync(path).isSymbolicLink()) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // listed but not on disk (deleted in a working tree)
    }
    if (mayHoldAName(text)) found.push(...findIn(file, text));
  }
  return found;
}

let scanned: Found[] | undefined;

const scanTrackedCopy = (): Found[] => (scanned ??= scanCheckout(REPO_ROOT));

/** The findings that no (file, text) pair in `allowed` covers. */
const notAllowed = (found: readonly Found[], allowed: readonly Allowed[] = ALLOWED) =>
  found.filter((f) => !allowed.some((a) => a.file === f.file && a.sha256 === f.sha256));

/** What a failure prints: the file, the line and the name's place, never the name or the text. */
const report = (found: readonly Found[]) => [
  ...new Set(found.map((f) => `${f.file}:${f.line} (customer name ${f.name})`)),
];

// The probes below are built from the pieces at run time, and a miss is
// reported by the name's place in the list and the form, so a failing run
// prints no name.
type Probe = { form: string; file: string; source: string; line: number };

/** Each probe that does not find name `name` on its line, as "name N, form". */
function misses(name: number, probes: readonly Probe[]): string[] {
  return probes
    .filter(
      (p) =>
        // A source the first-piece filter passes over is never read at all.
        !mayHoldAName(p.source) ||
        !findIn(p.file, p.source, []).some((f) => f.name === name && f.line === p.line),
    )
    .map((p) => `name ${name}, ${p.form}`);
}

// Each way a piece is lettered: its case, or full-width forms (which fold to
// plain letters and digits).
const LETTERINGS: readonly [string, (piece: string) => string][] = [
  ['lower case', (piece) => piece.toLowerCase()],
  ['upper case', (piece) => piece.toUpperCase()],
  ['title case', (piece) => piece.charAt(0).toUpperCase() + piece.slice(1).toLowerCase()],
  [
    'alternating case',
    (piece) => [...piece].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join(''),
  ],
  [
    'full-width letters',
    (piece) =>
      [...piece.toUpperCase()].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''),
  ],
];

const JOINS: readonly [string, string][] = [
  ['nothing', ''],
  ['a space', ' '],
  ['a hyphen', '-'],
  ['an underscore', '_'],
  ['a dot', '.'],
  ['a middle dot', '\u00B7'],
  // A run of separators, as SEPARATOR allows.
  ['a hyphen between spaces', ' - '],
  ['two spaces', '  '],
  ['a dot between spaces', ' . '],
  ['an underscore, a hyphen and an underscore', '_-_'],
];

/** Each place copy is read, holding `spelled` on the line given. */
function contexts(spelled: string): [where: string, file: string, source: string, line: number][] {
  return [
    ['a string literal', 'probe.ts', `export const label = '${spelled}';`, 1],
    [
      'a template literal with no substitution',
      'probe.ts',
      'export const label = `' + spelled + '`;',
      1,
    ],
    [
      'the head of a template literal',
      'probe.ts',
      'export const label = (n: number) => `' + spelled + ' has ${n} items`;',
      1,
    ],
    [
      'a template literal, after a substitution',
      'probe.ts',
      'export const label = (n: number) => `${n} items at ' + spelled + '`;',
      1,
    ],
    [
      'a JSX attribute value',
      'probe.tsx',
      `export const Field = () => <input placeholder="${spelled}" />;`,
      1,
    ],
    ['JSX text', 'probe.tsx', `export const Title = () => <p>Ship to ${spelled}</p>;`, 1],
  ];
}

describe("the copy people see names none of the customer's names", () => {
  it('finds no customer name in copy outside ALLOWED', () => {
    expect(report(notAllowed(scanTrackedCopy()))).toEqual([]);
  }, 120_000);

  it('still finds every ALLOWED entry', () => {
    const found = scanTrackedCopy();
    const stale = ALLOWED.filter(
      (a) => !found.some((f) => f.file === a.file && f.sha256 === a.sha256),
    );
    expect(stale.map((a) => `${a.file} (${a.why})`)).toEqual([]);
  }, 120_000);

  it('gives every ALLOWED entry a reason and lists each once', () => {
    for (const a of ALLOWED) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.why.length).toBeGreaterThan(20);
    }
    expect(new Set(ALLOWED.map((a) => `${a.file} ${a.sha256}`)).size).toBe(ALLOWED.length);
  });

  it('finds every name in each lettering and spelling, in each place copy is read', () => {
    const missed: string[] = [];
    CUSTOMER_NAMES.forEach((pieces, i) => {
      const probes: Probe[] = [];
      for (const [lettering, letter] of LETTERINGS) {
        const parts = pieces.map(letter);
        const joins = parts.length > 1 ? JOINS : JOINS.slice(0, 1);
        for (const [joinName, separator] of joins) {
          for (const [where, file, source, line] of contexts(parts.join(separator))) {
            probes.push({
              form: `${lettering}, ${joinName} between pieces, ${where}`,
              file,
              source,
              line,
            });
          }
        }
        // JSX text a person reads as one line: the pieces (or, for a name of
        // one piece, a word and the name) on lines of their own, or joined by
        // {' '}. The element starts on line 2 of the first and line 1 of the
        // second.
        const words = parts.length > 1 ? parts : ['Visit', parts[0]!];
        probes.push(
          {
            form: `${lettering}, JSX text split across lines`,
            file: 'probe.tsx',
            source: [
              'export const Title = () => (',
              '  <p>',
              ...words.map((w) => `    ${w}`),
              '  </p>',
              ');',
            ].join('\n'),
            line: 2,
          },
          {
            form: `${lettering}, JSX text split by {' '}`,
            file: 'probe.tsx',
            source: `export const Title = () => <p>${words.join("{' '}")}</p>;`,
            line: 1,
          },
        );
      }
      missed.push(...misses(i + 1, probes));
    });
    expect(missed).toEqual([]);
  });

  it('leaves lookalikes alone', () => {
    const missed: string[] = [];
    const finds = (name: number, text: string) =>
      findIn('probe.ts', `export const label = '${text}';`, []).some((f) => f.name === name);
    CUSTOMER_NAMES.forEach((pieces, i) => {
      const name = i + 1;
      const joined = pieces.join('');
      const spaced = pieces.join(' ');
      for (const [form, text] of [
        ['a letter right before it', `x${joined}`],
        ['a letter right after it', `${joined}x`],
        ['a digit right before it', `9${joined}`],
        ['a digit right after it', `${joined}9`],
        ['an accented letter right before it', `\u00E9${joined}`],
        ['inside an identifier-like word', `my${joined}Field`],
        ['a letter right after it, its pieces spaced', `${spaced}x`],
        ['digits right after it, its pieces hyphenated', `${pieces.join('-')}42`],
      ] as const) {
        if (finds(name, text)) missed.push(`name ${name}, ${form}`);
      }
      // Only some of its pieces, in order, and then another word.
      for (let n = 1; n < pieces.length; n += 1) {
        if (finds(name, `${pieces.slice(0, n).join(' ')} more`)) {
          missed.push(`name ${name}, its first ${n} of ${pieces.length} pieces`);
        }
      }
    });
    // The warehouse code (name 7) followed by more digits is another code.
    const [letters, digit] = CUSTOMER_NAMES[6]! as readonly [string, string];
    for (const text of [`${letters}${digit}2`, `${letters} ${digit}2`, `${letters}-${digit}0`]) {
      if (finds(7, text)) missed.push('name 7, more digits after the code');
    }
    // The full name's first piece (name 1) is a common verb: on its own it is
    // no name at all.
    const verb = CUSTOMER_NAMES[0]![0]!;
    for (const text of [
      `${verb} more about counts`,
      `${verb.toUpperCase()} HOW`,
      `How to ${verb}`,
    ]) {
      if (findIn('probe.ts', `export const label = '${text}';`, []).length > 0) {
        missed.push("name 1's first piece on its own");
      }
    }
    expect(missed).toEqual([]);
  });

  it('reads no comment, import path, identifier or regular expression literal', () => {
    const missed: string[] = [];
    CUSTOMER_NAMES.forEach((pieces, i) => {
      const spaced = pieces.join(' ');
      const identifier = pieces.join('_');
      const source = [
        `import { a } from './${pieces.join('-')}';`,
        `export { b } from './${pieces.join('-')}';`,
        `// ${spaced} in a line comment`,
        `/* ${spaced} in a block comment */`,
        `const ${identifier} = a;`,
        `const pattern = /${spaced}/i;`,
        `export const C = () => <p>{/* ${spaced} */}Generic text</p>;`,
        `export const D = () => <p title="Generic">{${identifier}}</p>;`,
      ].join('\n');
      const found = findIn('probe.tsx', source, []);
      if (found.length > 0) missed.push(`name ${i + 1}: ${found.length} findings`);
    });
    expect(missed).toEqual([]);
  });

  it('drops a JSX element for a name inside it, and nothing else', () => {
    const missed: string[] = [];
    const linesOf = (name: number, found: Found[]) =>
      found.filter((f) => f.name === name).map((f) => f.line);
    CUSTOMER_NAMES.forEach((pieces, i) => {
      const name = i + 1;
      const spelled = pieces.join(' ');
      const check = (form: string, got: number[], want: number[]) => {
        if (got.join(' ') !== want.join(' '))
          missed.push(`name ${name}, ${form}: lines ${got.join(' ')}`);
      };
      // (a) Two unrelated literals, the longer holding the shorter: both.
      const literals = [
        `export const SHORT = '${spelled}';`,
        `export const LONG = 'Ship to ${spelled} today';`,
      ].join('\n');
      check(
        '(a) a longer literal holding a shorter one',
        linesOf(name, findIn('probe.ts', literals, [])),
        [1, 2],
      );
      // A template literal and a literal in one of its substitutions: both.
      const template = [
        'export const G = (n: number) =>',
        '  `Ship to ' + spelled + ' ${',
        `    n > 1 ? '${spelled}' : ''`,
        '  }`;',
      ].join('\n');
      check(
        '(a) a literal inside a template literal',
        linesOf(name, findIn('probe.ts', template, [])),
        [2, 3],
      );
      // (b) A child element inside a parent: the child only.
      const nested = [
        'export const B = () => (',
        '  <div>',
        '    Before',
        '    <span>',
        `      ${spelled}`,
        '    </span>',
        '  </div>',
        ');',
      ].join('\n');
      check(
        '(b) a child element inside a parent',
        linesOf(name, findIn('probe.tsx', nested, [])),
        [4],
      );
      // (c) An element whose text holds the name only once its children are
      // joined: the element.
      if (pieces.length > 1) {
        const joined = [
          'export const C = () => (',
          '  <p>',
          `    <b>${pieces[0]}</b>`,
          `    ${pieces.slice(1).join(' ')}`,
          '  </p>',
          ');',
        ].join('\n');
        check(
          '(c) a name only in the joined text',
          linesOf(name, findIn('probe.tsx', joined, [])),
          [2],
        );
      }
      // (d) An attribute on a parent whose children's text names it too: both.
      const attribute = [
        'export const D = () => (',
        '  <p',
        `    title="${spelled}"`,
        '  >',
        `    Ship to ${spelled}`,
        '  </p>',
        ');',
      ].join('\n');
      check(
        '(d) an attribute and the children of one element',
        linesOf(name, findIn('probe.tsx', attribute, [])).sort((x, y) => x - y),
        [2, 3],
      );
      // (e) An allowed short literal does not hide a longer one holding it.
      const allowShort = [{ file: 'probe.ts', sha256: hashOf(spelled), why: 'a probe' }];
      check(
        '(e) an allowed short literal and a longer one',
        linesOf(name, notAllowed(findIn('probe.ts', literals, allowShort), allowShort)),
        [2],
      );
      // (f) An allowed literal among an element's children does not hide the
      // element's own text, while a literal that is not allowed stands in for
      // the element.
      const inside = [
        'export const F = () => (',
        '  <p>',
        `    Ship to ${spelled}`,
        `    {'${spelled}'}`,
        '  </p>',
        ');',
      ].join('\n');
      const allowInner = [{ file: 'probe.tsx', sha256: hashOf(spelled), why: 'a probe' }];
      check(
        '(f) an allowed literal inside an element',
        linesOf(name, notAllowed(findIn('probe.tsx', inside, allowInner), allowInner)),
        [2],
      );
      check('(f) a literal inside an element', linesOf(name, findIn('probe.tsx', inside, [])), [4]);
      // (g) Two literals on one line, the first allowed: the second is still
      // reported, so an allowed literal never hides another on its line.
      const oneLine = `export const PAIR = ['${spelled}', 'Ship to ${spelled}'];`;
      check(
        '(g) an allowed literal and another on its line',
        linesOf(name, notAllowed(findIn('probe.ts', oneLine, allowShort), allowShort)),
        [1],
      );
    });
    expect(missed).toEqual([]);
  });

  it('allows a text only in the file its ALLOWED pair names', () => {
    const missed: string[] = [];
    CUSTOMER_NAMES.forEach((pieces, i) => {
      const spelled = pieces.join(' ');
      // The same text, allowed in another file only.
      const elsewhere = [{ file: 'other.tsx', sha256: hashOf(spelled), why: 'a probe' }];
      const sources: [form: string, file: string, source: string][] = [
        ['a literal', 'probe.ts', `export const SHORT = '${spelled}';`],
        [
          "a literal among an element's children",
          'probe.tsx',
          [
            'export const F = () => (',
            '  <p>',
            `    Ship to ${spelled}`,
            `    {'${spelled}'}`,
            '  </p>',
            ');',
          ].join('\n'),
        ],
      ];
      for (const [form, file, source] of sources) {
        // Exactly what is found with nothing allowed: the literal, and the
        // element dropped for it.
        const want = findIn(file, source, []);
        const got = notAllowed(findIn(file, source, elsewhere), elsewhere);
        if (want.length === 0 || JSON.stringify(got) !== JSON.stringify(want)) {
          missed.push(`name ${i + 1}, ${form}: ${got.length} findings, ${want.length} expected`);
        }
      }
    });
    expect(missed).toEqual([]);
  });

  it('reads the screens and the code they share, and no test, fixture, test support or link', () => {
    const files = copyFiles(listTracked(REPO_ROOT));
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/mobile/app/(drawer)/ai.tsx',
        'apps/mobile/app.config.ts',
        'apps/web/src/components/ai/chat-panel.tsx',
        'apps/web/src/components/marketing/landing/console.tsx',
        'apps/web/src/components/marketing/landing/fixture.ts',
        'apps/web/src/components/auth/auth-stage.tsx',
        'apps/web/src/lib/releases/registry.ts',
        'packages/core/src/orders/readiness-copy.ts',
      ]),
    );
    expect(
      files.filter((f) =>
        /\.(?:test|spec)\.|__(?:fixtures|mocks)__\/|^apps\/web\/src\/test\//.test(f),
      ),
    ).toEqual([]);
    // A link git holds (mode 120000) is a path, not copy: skipped.
    const object = '0'.repeat(40);
    const records = [
      `120000 ${object} 0\tapps/web/src/components/linked-copy.tsx`,
      `100644 ${object} 0\tapps/web/src/components/real-copy.tsx`,
      `100755 ${object} 0\tapps/mobile/src/lib/run-copy.ts`,
      `100644 ${object} 0\tapps/web/src/components/real-copy.test.tsx`,
      `100644 ${object} 0\tapps/web/src/test/support.ts`,
      `100644 ${object} 0\tdocs/notes.ts`,
      '',
    ].join('\0');
    expect(copyFiles(records)).toEqual([
      'apps/web/src/components/real-copy.tsx',
      'apps/mobile/src/lib/run-copy.ts',
    ]);
  }, 30_000);

  it("holds no whole name in customer-identity.ts, pins its ten names, and its domains are S15's six", () => {
    const identity = 'apps/web/src/test/customer-identity.ts';
    expect(findIn(identity, readFileSync(join(REPO_ROOT, identity), 'utf8'), [])).toEqual([]);
    // sha256 of each name's pieces as JSON, in order: how many names there
    // are, their order, their spelling and where each splits into pieces. A
    // name changed or dropped would stop being found, and a piece split
    // elsewhere would stop its spaced spellings matching, with every probe
    // above still green, since they spell what the list holds.
    expect(CUSTOMER_NAMES.map((pieces) => sha256(JSON.stringify(pieces)))).toEqual([
      '060b8abcb6e147261a11e6066486c3c74c048f3a2dfda6c640a7da056b647bb9',
      '0f1a99ab345832bb9ff26b670bbf735092be38b4e788785287f8d90ebdfb35cd',
      '2d36f49695d8248f2ed3ce8407f03ca885912c94251e15663e44e631b265e574',
      'd02a6307efb50154fdf98fc76d342d3b7ab48d6db66854716a7b3672e7c882ca',
      'b27dd35b992844c600294bce6f8d8762112620d2e9eba65ffff48141d114127b',
      '22fac869e9e520fd59c5c8edbe804348a75aeea002476177c471eb24cedff6c2',
      '5eba5bd7d1b713c7ec8e82f30c054b7bbadcd4c3d21c44821ead21d1e9b55ab7',
      '15b6e2153f1f416f367ad53959db63a4a48435d173598e4b7071649b354c7f46',
      '6414976112102366adef15fc6cfbd541950fe1c20f3fd171e31b00f695cd4509',
      'f174ecc5faa6df8dbbcfad083757c64ef372edfd7e0fb2e17071fcf0de9af9f3',
    ]);
    // sha256 of each domain, in the order S15's guard has always read them.
    expect(CUSTOMER_DOMAINS.map(sha256)).toEqual([
      '2ae6be2eb6e43a564325887a402869fcda978960b5902c8aa3105356a5c019f0',
      '4788bb0d6a719773cfedbdaffe62c23ecd2f0e14805968ef173c50ff98140fa5',
      '421f1c94797a82af8c11dacff10fc48b85d5eb6d400e3f193eed319d137025f0',
      '30937e7cb51908bd026a6f9c094a5a02fdf32267bf788faeaeb5f1bafdceeb74',
      '314cdd30beaf2780622f24b56a494330b9f28ac9f496dc1ae4060eda693f9dea',
      '8303e4066e8531598cc1c500b85b9222fbba60b18992e7694cb59f24c5f0ac90',
    ]);
  });
});
