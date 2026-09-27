/**
 * RECURRENCE GUARD: web screens never call the recorded quantity "the book".
 *
 * Owner report 2026-09-27: an L4L Chromebook's Physical count card read "Book
 * corrected from 50 to 0 (-50)", "Book now: 0" and "Count did not match the
 * book". "Book" was accounting shorthand for the quantity StockPilot has on
 * record, but L4L stocks real books (the Books section), so the owner read it
 * as the product. The words were changed to "stock on record".
 *
 * Most of that copy lives in core, and packages/core/src/warehouse/
 * on-record-wording.guard.test.ts guards it there. This guard covers the words
 * the web app writes itself: every string literal, template literal and piece
 * of JSX text under apps/web/src (tests, mocks and fixtures excluded) is
 * searched for the phrases the jargon used. JSX text is read element by
 * element, with its children joined, so "the{' '}book" or a phrase broken
 * across lines is read the way a person sees it. The phone has the same guard
 * (apps/mobile/src/lib/on-record-wording.guard.test.ts).
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

const WEB_SRC = path.resolve(__dirname, '..');

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

/** The Books feature's own modules (paths under apps/web/src; a trailing "/"
 *  is a directory, anything else a file or a file-name prefix). */
const BOOKS_FEATURE_PATHS = [
  'app/(dashboard)/dashboard/books/',
  'app/api/books/',
  'app/api/v1/books/',
  'components/books/',
  'components/inventory/book-custom-fields.ts',
  'components/inventory/refresh-book-prices-button.tsx',
  'lib/book-storage.ts',
  'lib/books/',
  'server/actions/books-',
  'server/pricing/google-books-client.ts',
  'server/services/books-import.ts',
];

/** Shared files that name a real book in a fixed phrase: a book's crate
 *  label, or the AI prompt that tells a book from a product. The matched text
 *  is taken out before the check, so anything else in the literal is still
 *  read. Every phrase must still be in its file (checked below). */
const BOOKS_PHRASES: Record<string, RegExp[]> = {
  'app/api/v1/ai/identify-from-photo/route.ts': [/\bidentifying the book or general product\b/g],
  'components/inventory/crate-fields.tsx': [
    /\brecorded on the book\b/g,
    /\bthe book[’']s crate label\b/g,
  ],
  'components/inventory/place-from-staging-dialog.tsx': [/\bcheck the book[’']s details\b/gi],
  'components/inventory/remove-from-rack-dialog.tsx': [/\bcheck the book[’']s details\b/gi],
  'components/inventory/stock-transfer-dialog.tsx': [/\bcheck the book[’']s details\b/gi],
  'lib/ai/tools.ts': [
    /\bdoes NOT add the book to inventory\b/g,
    /\bidentifying the book or product\b/g,
  ],
  'lib/exports/export-request.ts': [/\bThe book catalog layout\b/g],
};

/** The What's New release that announces this change quotes the old words on
 *  purpose ("Book corrected from 50 to 0 (-50) now reads ..."). Only its object
 *  in the registry is skipped; every other release is read like any other
 *  copy (and registry.test.ts checks them as well). */
const REGISTRY = 'lib/releases/registry.ts';
const QUOTES_OLD_WORDING = new Set(['stock-on-record-wording-2026-09-27']);

const rel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join('/');

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

/** The `id` of an object literal, when it is a plain string. */
function objectId(node: ts.ObjectLiteralExpression): string | null {
  for (const p of node.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'id' &&
      ts.isStringLiteral(p.initializer)
    ) {
      return p.initializer.text;
    }
  }
  return null;
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
  const skipObjects = rel(file) === REGISTRY;
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
    if (skipObjects && ts.isObjectLiteralExpression(node)) {
      const id = objectId(node);
      if (id && QUOTES_OLD_WORDING.has(id)) return;
    }
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

describe('the web app\'s copy never calls the recorded quantity "the book"', () => {
  const files = sourceFiles(WEB_SRC);
  const byRel = new Map(files.map((f) => [rel(f), f]));

  it('reads the screens, and its Books allowances still name real files and phrases', () => {
    const paths = [...byRel.keys()];
    expect(paths).toEqual(
      expect.arrayContaining([
        'components/inventory/item-verification-card.tsx',
        'components/inventory/bulk-actions.tsx',
        'app/(dashboard)/dashboard/exceptions/page.tsx',
        REGISTRY,
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
    const registry = readFileSync(byRel.get(REGISTRY)!, 'utf8');
    for (const id of QUOTES_OLD_WORDING) expect(registry).toContain(`id: '${id}'`);
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
      expect(jargonIn('components/inventory/some-card.tsx', copy(text)), text).not.toEqual([]);
    }
    // A Books phrase is taken out only in its own file, and nothing else in
    // the same literal is let through.
    const details = 'Moved, but its crate label could not be updated — check the book’s details.';
    expect(jargonIn('components/inventory/stock-transfer-dialog.tsx', copy(details))).toEqual([]);
    expect(jargonIn('components/inventory/item-verification-card.tsx', copy(details))).toEqual([
      `components/inventory/item-verification-card.tsx:1 "the book": ${details}`,
    ]);
    expect(
      jargonIn(
        'components/inventory/stock-transfer-dialog.tsx',
        copy(`${details} Count did not match the book.`),
      ),
    ).not.toEqual([]);
    // A Books module may say "the book", never the other phrases.
    expect(jargonIn('components/books/books-inventory-table.tsx', copy('Open the book'))).toEqual(
      [],
    );
    expect(
      jargonIn('components/books/books-inventory-table.tsx', copy('Book now: 3')),
    ).toHaveLength(1);
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
      expect(jargonIn('components/inventory/some-card.tsx', copy(text)), text).toEqual([]);
    }
  });

  it('reads JSX text the way a person sees it', () => {
    const probe = path.join(WEB_SRC, 'lib', 'probe.tsx');
    const src = [
      'export const A = () => (',
      '  <p>',
      '    Count did not match the{" "}',
      '    book',
      '  </p>',
      ');',
      'export const B = () => <p>Book <strong>now</strong>: {3}</p>;',
      '// Book now: a comment is not copy',
      'export const C = () => <p>{/* the book */}On record now</p>;',
    ].join('\n');
    const texts = copyInSource(probe, src).map((c) => c.text);
    expect(texts).toContain('Count did not match the book');
    expect(texts).toContain('Book now : ${…}');
    expect(texts).toContain('On record now');
    expect(jargonIn('lib/probe.tsx', copyInSource(probe, src))).toEqual([
      'lib/probe.tsx:2 "the book": Count did not match the book',
      'lib/probe.tsx:2 "Matched the book": Count did not match the book',
      'lib/probe.tsx:7 "Book now": Book now : ${…}',
    ]);
  });
});
