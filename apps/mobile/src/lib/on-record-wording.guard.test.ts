/**
 * RECURRENCE GUARD: phone screens never call the recorded quantity "the book".
 *
 * Owner report 2026-09-27: an L4L Chromebook's Physical count card read "Book
 * corrected from 50 to 0 (-50)", "Book now: 0" and "Count did not match the
 * book". "Book" was accounting shorthand for the quantity StockPilot has on
 * record, but L4L stocks real books (the Books section), so the owner read it
 * as the product. The words were changed to "stock on record".
 *
 * Most of that copy lives in core, and packages/core/src/warehouse/
 * on-record-wording.guard.test.ts guards it there. This guard covers the words
 * the phone writes itself: every string literal, template literal and piece of
 * JSX text under apps/mobile/src and apps/mobile/app (tests, mocks and
 * fixtures excluded) is searched for the phrases the jargon used. JSX text is
 * read element by element, with its children joined, so "the{' '}book" or a
 * phrase broken across lines is read the way a person sees it. The web app has
 * the same guard (apps/web/src/lib/on-record-wording.guard.test.ts).
 *
 * The real Books feature is not affected. Its own modules
 * (BOOKS_FEATURE_PATHS) may say "the book", and a few shared screens name a
 * book the organization stocks in a fixed phrase (BOOKS_PHRASES). No file may
 * use the other phrases, which were never about a real book.
 *
 * IF THIS FAILS: say "the stock on record" (or "what StockPilot had on
 * record") for the recorded quantity. If the text really is about a book the
 * organization stocks, add its file to BOOKS_FEATURE_PATHS (a Books module) or
 * the exact phrase to BOOKS_PHRASES (a shared screen).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = path.resolve(__dirname, '../..');
/** The two trees the phone's code lives in. */
const SCANNED = ['src', 'app'];

/** The phrases the recorded-quantity jargon used. Only "the book" is ever
 *  also a Books phrase ("check the book's details"). */
const JARGON: readonly { name: string; re: RegExp; booksMayUse?: true }[] = [
  { name: '"the book"', re: /\bthe book\b/i, booksMayUse: true },
  { name: '"Book now"', re: /\bBook now\b/ },
  { name: '"Book corrected"', re: /\bbook corrected\b/i },
  { name: '"Matched the book"', re: /\bmatch(?:ed|es)? the book\b/i },
  { name: '"on the books"', re: /\bon the books\b/i },
  { name: '"book quantity"', re: /\bbook (?:qty|quantity|quantities)\b/i },
  { name: '"counted 11, book 10"', re: /,\s*book\s+(?:\$\{|\d)/i },
];

/** The Books feature's own modules (paths under apps/mobile; a trailing "/"
 *  is a directory, anything else a file or a file-name prefix). */
const BOOKS_FEATURE_PATHS = ['app/(drawer)/(tabs)/books.tsx', 'src/components/AddBookCard.tsx'];

/** Shared files that name a real book in a fixed phrase: a book's crate
 *  label, after a move or a put-away. The matched text is taken out before
 *  the check, so anything else in the literal is still read. Every phrase must
 *  still be in its file (checked below). */
const BOOKS_PHRASES: Record<string, RegExp[]> = {
  'src/lib/move-stock-form.ts': [/\bcheck the book[’']s details\b/gi],
};

const rel = (file: string) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__mocks__' || name === '__fixtures__') continue;
      out.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/.test(name) &&
      !/\.(?:test|spec)\.tsx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

type Copy = { line: number; text: string };

/**
 * Every piece of copy in a file, as written: string and template literals (a
 * template's substitutions read "${…}") and the text of each JSX element with
 * its children joined (an expression child reads "${…}" unless it is a string,
 * a nested element contributes its own text, whitespace collapses). Comments
 * and import paths are not copy and are skipped.
 */
function copyInSource(file: string, text: string): Copy[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Copy[] = [];
  const at = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const jsxText = new Map<ts.Node, string>();
  const flatten = (node: ts.JsxElement | ts.JsxFragment): string => {
    const known = jsxText.get(node);
    if (known !== undefined) return known;
    const parts = node.children.map((child): string => {
      if (ts.isJsxText(child)) return child.text;
      if (ts.isJsxExpression(child)) {
        const e = child.expression;
        if (!e) return '';
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
        return '${…}';
      }
      if (ts.isJsxElement(child) || ts.isJsxFragment(child)) return ` ${flatten(child)} `;
      return ' ';
    });
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    jsxText.set(node, text);
    return text;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: at(node), text: node.text });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('');
      out.push({ line: at(node), text });
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const text = flatten(node);
      if (text) out.push({ line: at(node), text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const copyIn = (file: string): Copy[] => copyInSource(file, readFileSync(file, 'utf8'));

function isBooksFeature(relPath: string): boolean {
  return BOOKS_FEATURE_PATHS.some((p) => relPath.startsWith(p));
}

/** Every jargon phrase in one file's copy, after its Books phrases are taken
 *  out. A JSX element's text holds its children's, so a phrase found in both
 *  is reported once, at the innermost element. */
function jargonIn(relPath: string, copy: Copy[]): string[] {
  const books = isBooksFeature(relPath);
  const phrases = BOOKS_PHRASES[relPath] ?? [];
  const hits: (Copy & { name: string })[] = [];
  for (const { line, text } of copy) {
    const read = phrases.reduce((t, re) => t.replace(re, '…'), text);
    for (const { name, re, booksMayUse } of JARGON) {
      if (books && booksMayUse) continue;
      if (re.test(read)) hits.push({ line, text, name });
    }
  }
  const innermost = hits.filter(
    (h) => !hits.some((o) => o.name === h.name && o.text !== h.text && h.text.includes(o.text)),
  );
  return [
    ...new Set(innermost.map((h) => `${relPath}:${h.line} ${h.name}: ${h.text.slice(0, 160)}`)),
  ];
}

describe('the phone\'s copy never calls the recorded quantity "the book"', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir)));
  const byRel = new Map(files.map((f) => [rel(f), f]));

  it('reads the screens, and its Books allowances still name real files and phrases', () => {
    const paths = [...byRel.keys()];
    expect(paths).toEqual(
      expect.arrayContaining([
        'src/components/item-verification-card.tsx',
        'src/components/exception-recount-sheet.tsx',
        'src/lib/exceptions-api.ts',
        'app/(drawer)/(tabs)/inventory.tsx',
      ]),
    );
    expect(paths.some((p) => /\.test\.tsx?$/.test(p))).toBe(false);
    for (const p of BOOKS_FEATURE_PATHS) {
      expect(
        paths.some((f) => f.startsWith(p)),
        p,
      ).toBe(true);
    }
    for (const [file, phrases] of Object.entries(BOOKS_PHRASES)) {
      const abs = byRel.get(file);
      expect(abs, file).toBeDefined();
      const copy = copyIn(abs!);
      for (const re of phrases) {
        expect(
          copy.some(({ text }) => new RegExp(re.source, re.flags.replace('g', '')).test(text)),
          `${file} ${re}`,
        ).toBe(true);
      }
    }
  });

  it('no string literal, template literal or JSX text uses a recorded-quantity "book" phrase', () => {
    const found = files.flatMap((f) => jargonIn(rel(f), copyIn(f)));
    expect(found).toEqual([]);
  }, 60_000);

  it('would catch the wording the owner reported, in any of the forms a screen writes it', () => {
    const copy = (text: string) => [{ line: 1, text }];
    for (const text of [
      'Book corrected from ${…} to ${…} (${…})',
      'Book now: ${…}',
      'Count did not match the book',
      'Matched the book (${…})',
      'Counted ${…}, book ${…}',
      'Archiving keeps the stock on the books',
      'Book quantity',
    ]) {
      expect(jargonIn('src/components/some-card.tsx', copy(text)), text).not.toEqual([]);
    }
    // A Books phrase is taken out only in its own file, and nothing else in
    // the same literal is let through.
    const details = "Its crate label could not be written — check the book's details.";
    expect(jargonIn('src/lib/move-stock-form.ts', copy(details))).toEqual([]);
    expect(jargonIn('src/components/item-verification-card.tsx', copy(details))).toEqual([
      `src/components/item-verification-card.tsx:1 "the book": ${details}`,
    ]);
    expect(
      jargonIn('src/lib/move-stock-form.ts', copy(`${details} Count did not match the book.`)),
    ).not.toEqual([]);
    // A Books module may say "the book", never the other phrases.
    expect(jargonIn('app/(drawer)/(tabs)/books.tsx', copy('Open the book'))).toEqual([]);
    expect(jargonIn('app/(drawer)/(tabs)/books.tsx', copy('Book now: 3'))).toHaveLength(1);
    // The replacements and the Books section's own names are not caught.
    for (const text of [
      'Stock on record corrected from ${…} to ${…} (${…})',
      'On record now: ${…}',
      'Count did not match the stock on record',
      'Counted ${…}, on record ${…}',
      'Books',
      'New book',
      'Scan a book',
    ]) {
      expect(jargonIn('src/components/some-card.tsx', copy(text)), text).toEqual([]);
    }
  });

  it('reads JSX text the way a person sees it', () => {
    const probe = path.join(MOBILE_ROOT, 'src', 'lib', 'probe.tsx');
    const src = [
      'export const A = () => (',
      '  <Text>',
      '    Count did not match the{" "}',
      '    book',
      '  </Text>',
      ');',
      'export const B = () => <Text>Book <Text style={s}>now</Text>: {3}</Text>;',
      '// Book now: a comment is not copy',
      'export const C = () => <Text>{/* the book */}On record now</Text>;',
    ].join('\n');
    const texts = copyInSource(probe, src).map((c) => c.text);
    expect(texts).toContain('Count did not match the book');
    expect(texts).toContain('Book now : ${…}');
    expect(texts).toContain('On record now');
    expect(jargonIn('src/lib/probe.tsx', copyInSource(probe, src))).toEqual([
      'src/lib/probe.tsx:2 "the book": Count did not match the book',
      'src/lib/probe.tsx:2 "Matched the book": Count did not match the book',
      'src/lib/probe.tsx:7 "Book now": Book now : ${…}',
    ]);
  });
});
