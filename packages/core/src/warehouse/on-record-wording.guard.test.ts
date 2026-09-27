/**
 * RECURRENCE GUARD: counts and exceptions say "stock on record", never "book".
 *
 * Owner report 2026-09-27: an L4L Chromebook's Physical count card read "Book
 * corrected from 50 to 0 (-50)", "Book now: 0" and "EX-000058 · Count did not
 * match the book". "Book" was accounting shorthand for the quantity StockPilot
 * has on record, but L4L stocks real books (the Books section), so the owner
 * read it as the product and asked why an electronics item showed as a book.
 *
 * The words live here in core, so the web app and the phone read the same.
 * Two checks keep the jargon out:
 *   1. every count, recount, exception and verification line core composes is
 *      rendered and searched for the word "book";
 *   2. every string and template literal in core's source is searched for the
 *      phrases the jargon used ("the book", "Book now", "Book corrected",
 *      "Matched the book", "counted 11, book 10"...), so new copy cannot bring
 *      it back either.
 *
 * The real Books feature (item_type 'book', book racks and crates, ISBN, book
 * covers) is untouched: its modules are listed in BOOKS_FEATURE_FILES and are
 * the only place check 2 lets "the book" through.
 *
 * IF THIS FAILS: say "the stock on record" (or "what StockPilot had on
 * record") for the recorded quantity. If the string really is about a book the
 * organization stocks, and lives in a Books module, add that file below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  describeOccurrence,
  EXCEPTION_ALL_CLEAR_BODY,
  EXCEPTION_RULE_IDS,
  EXCEPTION_RULES,
} from './exceptions';
import {
  activeRecountCopy,
  describeTimelineEvent,
  recountOutcomeCopy,
  varianceReviewLine,
  type RecountOutcome,
} from './exception-recount';
import {
  locationRowVerificationCopy,
  verificationIssueChipCopy,
  verificationResultCopy,
  verificationSummaryCopy,
  type ItemVerificationSummary,
  type VerificationLastCount,
} from './verification';

/** The word itself, in any case ("book", "Book", "book's"). */
const BOOK_WORD = /\bbook\b/i;

/** The phrases the recorded-quantity jargon used. None is ever a Books phrase
 *  except "the book", which BOOKS_FEATURE_FILES may use. */
const JARGON: ReadonlyArray<{ name: string; re: RegExp; booksMayUse?: true }> = [
  { name: '"the book"', re: /\bthe book\b/i, booksMayUse: true },
  { name: '"Book now"', re: /\bBook now\b/ },
  { name: '"Book corrected"', re: /\bbook corrected\b/i },
  { name: '"Matched the book"', re: /\bmatch(?:ed|es)? the book\b/i },
  { name: '"on the books"', re: /\bon the books\b/i },
  { name: '"book quantity"', re: /\bbook (?:qty|quantity|quantities)\b/i },
  { name: '"counted 11, book 10"', re: /,\s*book\s+(?:\$\{|\d)/i },
];

/** The real Books feature: the only core modules whose copy may say "the book". */
const BOOKS_FEATURE_FILES = new Set([
  'inventory/book-storage.ts',
  'inventory/book-crate-placement.ts',
  'inventory/book-rack-placement.ts',
  'pricing/google-books.ts',
]);

// ── 1. What core composes ───────────────────────────────────────────────────

const OUTCOMES: RecountOutcome[] = [
  { kind: 'in_progress', counted: 1, total: 3 },
  { kind: 'in_progress', counted: null, total: null },
  { kind: 'cancelled' },
  { kind: 'not_counted' },
  { kind: 'matched', quantity: 10 },
  { kind: 'corrected', from: 50, to: 0, delta: -50 },
  { kind: 'corrected', from: 8, to: 10, delta: 2 },
  { kind: 'superseded' },
  { kind: 'unavailable' },
];

function lastCount(o: Partial<VerificationLastCount> = {}): VerificationLastCount {
  return {
    cycleCountId: 'cc-58',
    countNumber: 58,
    completedAt: '2026-09-26T16:00:00Z',
    countedAt: '2026-09-26T15:02:00Z',
    capturedAt: null,
    baselineAt: '2026-09-26T15:02:00Z',
    expectedQuantity: 50,
    expectedAtStart: 50,
    countedQuantity: 0,
    countedLocationId: 'loc-1',
    countedLocation: { name: '31-C', kind: 'rack', type: 'shelf', archived: false },
    aiAssisted: false,
    countedBy: { id: 'u-a', label: 'Avery' },
    postedBy: { id: 'u-b', label: 'Blake' },
    ...o,
  };
}

function chromebook(o: Partial<ItemVerificationSummary> = {}): ItemVerificationSummary {
  return {
    itemId: 'item-1',
    item: {
      status: 'active',
      isRental: false,
      isBundle: false,
      deleted: false,
      countable: true,
      quantityOnHand: 0,
    },
    lastCount: lastCount(),
    movementsSince: 0,
    outsideLedgerSince: 0,
    openCount: null,
    ...o,
  };
}

/** Every line a count, recount, exception or verification surface can show. */
function composedCopy(): string[] {
  const out: string[] = [];
  for (const rule of EXCEPTION_RULE_IDS) {
    const meta = EXCEPTION_RULES[rule];
    out.push(meta.label, meta.action, meta.clearedBy, ...meta.explanations);
    out.push(verificationIssueChipCopy({ number: 58, rule }));
  }
  out.push(EXCEPTION_ALL_CLEAR_BODY);
  const facts = {
    itemName: 'LENOVO 500E 11 G5 MTK540 64/8 CHROME',
    sku: 'L-500E',
    cycleCountId: 'cc-58',
    countNumber: 58,
    observedAt: '2026-09-26T15:02:00Z',
    completedAt: '2026-09-26T16:00:00Z',
    expected: 50,
    counted: 0,
    variance: -50,
    countedLocationName: '31-C',
    aiAssisted: false,
    capturedOfflineAt: null,
  };
  const occurrence = describeOccurrence('count_variance', facts);
  out.push(occurrence.title, occurrence.detail);
  // Numbers the evaluator could not supply: the words-only line.
  out.push(describeOccurrence('count_variance', { itemName: 'A', countNumber: 58 }).detail);
  for (const outcome of OUTCOMES) {
    out.push(recountOutcomeCopy(outcome));
    out.push(activeRecountCopy({ countNumber: 58, outcome }));
    out.push(
      describeTimelineEvent({
        kind: 'recount_closed',
        actorLabel: null,
        cycleCountNumber: 58,
        recountOutcome: outcome,
      }),
    );
  }
  const rack = { name: '31-C', kind: 'rack' };
  for (const [counted, expected] of [
    [0, 50],
    [11, 10],
    [10, 10],
  ] as const) {
    for (const rechecks of [true, false, null]) {
      const line = varianceReviewLine({
        countedQuantity: counted,
        expectedQuantity: expected,
        countedLocation: rack,
        rechecks,
      });
      if (line) out.push(line);
    }
  }
  for (const count of [
    lastCount(),
    lastCount({ countedQuantity: 50 }),
    lastCount({ expectedAtStart: null }),
  ]) {
    const result = verificationResultCopy(count);
    if (result) out.push(result);
    const summary = chromebook({ lastCount: count });
    for (const canCount of [true, false]) {
      out.push(
        ...verificationSummaryCopy(summary, { timeZone: 'America/Chicago', canCount }).lines,
      );
    }
    const row = locationRowVerificationCopy(summary, 'loc-1', {
      timeZone: 'America/Chicago',
      locationKind: 'rack',
      locationType: 'shelf',
    });
    out.push(row.count);
    if (row.movementsSince) out.push(row.movementsSince);
  }
  out.push(...verificationSummaryCopy(chromebook({ lastCount: null }), { canCount: true }).lines);
  out.push(...verificationSummaryCopy(null).lines);
  return out;
}

describe('counts and exceptions word the recorded quantity as "stock on record"', () => {
  it('the owner-reported card reads in plain words', () => {
    const lines = verificationSummaryCopy(chromebook(), { timeZone: 'America/Chicago' }).lines;
    expect(lines).toContain('Stock on record corrected from 50 to 0 (-50)');
    expect(lines).toContain('On record now: 0');
    expect(verificationIssueChipCopy({ number: 58, rule: 'count_variance' })).toBe(
      'EX-000058 · Count did not match the stock on record',
    );
    expect(recountOutcomeCopy({ kind: 'matched', quantity: 10 })).toBe(
      'Matched the stock on record (10)',
    );
    expect(EXCEPTION_RULES.count_variance.label).toBe('Count did not match the stock on record');
  });

  it('no line core composes for them says "book"', () => {
    const lines = composedCopy();
    // The fixtures reach the count lines, not only the empty states.
    expect(lines.length).toBeGreaterThan(60);
    expect(lines.filter((l) => BOOK_WORD.test(l))).toEqual([]);
  });
});

// ── 2. Core's source ────────────────────────────────────────────────────────

const CORE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
      out.push(full);
  }
  return out;
}

/** Every string and template literal in a file, as written (a template's
 *  substitutions read "${…}"), with its line. Comments and import paths are
 *  not copy and are skipped. */
function literals(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const out: Array<{ line: number; text: string }> = [];
  const at = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: at(node), text: node.text });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((s) => '${…}' + s.literal.text).join('');
      out.push({ line: at(node), text });
      // Substitutions may hold literals of their own.
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("core's copy never brings the jargon back", () => {
  const files = sourceFiles(CORE_SRC);

  it('reads the modules the copy lives in', () => {
    const rel = files.map((f) => path.relative(CORE_SRC, f).split(path.sep).join('/'));
    expect(rel).toEqual(
      expect.arrayContaining([
        'warehouse/exceptions.ts',
        'warehouse/exception-recount.ts',
        'warehouse/verification.ts',
        'cycle-counts/capture-label.ts',
      ]),
    );
    for (const books of BOOKS_FEATURE_FILES) expect(rel).toContain(books);
  });

  it('no string or template literal uses a recorded-quantity "book" phrase', () => {
    const found: string[] = [];
    for (const file of files) {
      const rel = path.relative(CORE_SRC, file).split(path.sep).join('/');
      const books = BOOKS_FEATURE_FILES.has(rel);
      for (const { line, text } of literals(file)) {
        for (const { name, re, booksMayUse } of JARGON) {
          if (books && booksMayUse) continue;
          if (re.test(text)) found.push(`${rel}:${line} ${name}: ${text}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('would catch the wording the owner reported', () => {
    const reported = [
      'Book corrected from ${…} to ${…} (${…})',
      'Book now: ${…}',
      'Count did not match the book',
      'Matched the book (${…})',
      'Counted ${…}, book ${…}',
      'found ${…}: counted ${…}, book ${…}${…}',
      'keeps the stock on the books',
    ];
    for (const text of reported) {
      expect(
        JARGON.some(({ re }) => re.test(text)),
        text,
      ).toBe(true);
    }
    // The replacements and the real Books feature's names are not caught.
    for (const text of [
      'Stock on record corrected from ${…} to ${…} (${…})',
      'On record now: ${…}',
      'Count did not match the stock on record',
      'Counted ${…}, on record ${…}',
      'Books',
      'New book',
      'Scan a book on the Scan tab to add one',
      'Duplicating an item that is not a book now puts the copy on the rack',
    ]) {
      expect(
        JARGON.some(({ re }) => re.test(text)),
        text,
      ).toBe(false);
    }
  });
});
