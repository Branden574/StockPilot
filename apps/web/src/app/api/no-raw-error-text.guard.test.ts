import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket S16): no API route answers an error's own text.
 *
 * A route's last catch used to answer anything that was not a ServiceError
 * with `e instanceof Error ? e.message : ...`, and a few branches answered a
 * Supabase or Storage `error.message` without a catch. The caller then read
 * whatever the error said: a TypeError naming the server's property paths,
 * Postgres text naming tables, columns and row-level security policies, a
 * Storage error naming the bucket, an AI vendor's quota or billing text, a
 * failed request's URL with its token. Many of those branches reported
 * nothing, so the answer was the only copy of the error. They now answer
 * through server/lib/api-error-response.ts: a fixed sentence to the caller,
 * the error itself to reportError with the route's tag.
 *
 * This reads every module under app/api and every response helper (http.ts,
 * *-http.ts, *error-response.ts, export-errors.ts) anywhere in src, without
 * comments (taken from the TypeScript syntax tree, so text in a string is
 * never mistaken for a comment), and finds four shapes of an error's own
 * text (its message or its stack):
 *
 *   ternary   `e instanceof Error ? e.message : ...`
 *   cast      `(e as Error).message`
 *   property  `message: rpcErr.message`, `detail: err.message`, `error: error?.message`
 *   template  `` `failed: ${error.message}` ``
 *
 * The text of a `new Error(`...`)` is not counted: that Error is thrown or
 * reported, and every catch that answers is held to these same shapes. A
 * ServiceError's or ForbiddenError's `e.message` is not one of these shapes:
 * those messages are written by the app (an internal_error's is already
 * generic, S13). Every remaining line is listed below with why it is safe,
 * so a new one fails here until someone reasons about it.
 */

const SRC = path.resolve(__dirname, '../..');
const API = path.join(SRC, 'app/api');

/** Response helpers outside app/api answer API callers too. */
const RESPONSE_HELPER = /^(?:.+-)?http\.ts$|^(?:.+-)?error-response\.ts$|^export-errors\.ts$/;

const TEXT = String.raw`(?:message|stack)`;
const ERROR_NAME = String.raw`(?:e|err|error|\w+Err|\w+Error)`;
const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'ternary',
    new RegExp(String.raw`\b(\w+)\s+instanceof\s+Error\s*\?\s*\1\s*\??\.\s*${TEXT}\b`, 'g'),
  ],
  ['cast', new RegExp(String.raw`\(\s*\w+\s+as\s+Error\s*\)\s*\??\.\s*${TEXT}\b`, 'g')],
  ['property', new RegExp(String.raw`:\s*\w*(?:Err|Error|err|error)\s*\??\.\s*${TEXT}\b`, 'g')],
  ['template', new RegExp(String.raw`\$\{[^}]*\b${ERROR_NAME}\s*\??\.\s*${TEXT}\b`, 'g')],
];

/** A template literal handed straight to `new Error(`: only ever thrown or reported. */
const NEW_ERROR_TEMPLATE = /new\s+Error\(\s*`[^`]*`/g;

/**
 * Files allowed to keep the shapes, with the number of lines and the reason.
 * Each line was read: none of them reaches a caller.
 */
const ALLOWED: Record<string, { lines: number; why: string }> = {
  'app/api/v1/mobile/snapshot/route.ts': {
    lines: 3,
    why: "the top-level catch's report and server log (its answer is { error, code: 'snapshot_uncaught' }), and the items read's failure, which dbError only reports",
  },
  'app/api/orders/[id]/packing-slip-warehouse.pdf/route.tsx': {
    lines: 1,
    why: 'the QR code failure goes to console.error only; the slip renders without it',
  },
  'app/api/purchase-orders/export.csv/route.ts': {
    lines: 1,
    why: 'the value is a ServiceError (narrowed by instanceof), whose internal_error message is generic (S13)',
  },
  'app/api/admin/backfill-item-thumbs/route.ts': {
    lines: 3,
    why: "per-row results for the BACKFILL_ADMIN_SECRET holder, who needs them to diagnose a row (kept by the owner's default, S16 decision 2); the route's own failures answer through the helper",
  },
};

interface Hit {
  line: number;
  text: string;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Every module the census reads: app/api, and the response helpers elsewhere. */
function scope(): string[] {
  const helpers = files(SRC).filter(
    (file) => !file.startsWith(API + path.sep) && RESPONSE_HELPER.test(path.basename(file)),
  );
  return [...files(API), ...helpers];
}

/**
 * The source with every comment blanked (newlines kept, so line numbers hold).
 * Comments come from the syntax tree: the leading and trailing comments of
 * every token. A regex would take a string such as 'image/*' for the start of
 * a comment and hide the code after it.
 */
function withoutComments(fileName: string, source: string): string {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const chars = source.split('');
  const blank = (range: ts.CommentRange) => {
    for (let i = range.pos; i < range.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  const visit = (node: ts.Node) => {
    // JSX text is text, never a comment, whatever it contains.
    if (node.kind !== ts.SyntaxKind.JsxText) {
      ts.getLeadingCommentRanges(source, node.pos)?.forEach(blank);
      ts.getTrailingCommentRanges(source, node.end)?.forEach(blank);
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return chars.join('');
}

/** The lines of `source` that carry one of the shapes. */
function hitsIn(fileName: string, source: string): Hit[] {
  const code = withoutComments(fileName, source).replace(NEW_ERROR_TEMPLATE, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  const lines = new Set<number>();
  for (const [, shape] of SHAPES) {
    for (const match of code.matchAll(shape)) {
      lines.add(code.slice(0, match.index).split('\n').length);
    }
  }
  const sourceLines = source.split('\n');
  return [...lines]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: (sourceLines[line - 1] ?? '').trim() }));
}

function census(): Map<string, Hit[]> {
  const found = new Map<string, Hit[]>();
  for (const file of scope()) {
    const hits = hitsIn(file, readFileSync(file, 'utf8'));
    if (hits.length > 0) found.set(path.relative(SRC, file), hits);
  }
  return found;
}

describe("API routes never answer an error's own text", () => {
  it("no API route answers an error's own text: every remaining line is listed, as often as listed", () => {
    const found = census();
    // Every line of a file whose count is off, so a failure says where to look.
    const off = [...found]
      .filter(([file, hits]) => hits.length !== (ALLOWED[file]?.lines ?? 0))
      .flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line}: ${hit.text}`));
    expect(off).toEqual([]);
    expect(Object.fromEntries([...found].map(([file, hits]) => [file, hits.length]))).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([file, { lines }]) => [file, lines])),
    );
  });

  it('every allowed file gives its reason', () => {
    for (const [file, { lines, why }] of Object.entries(ALLOWED)) {
      expect(lines, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });

  it('the census sees what it is for (control): each shape in code, none in comments or in a new Error', () => {
    const sample = [
      "return NextResponse.json({ error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' });",
      "return NextResponse.json({ error: 'invalid_form', message: (e as Error).message });",
      "return NextResponse.json({ error: 'internal_error', message: rpcErr.message });",
      'return NextResponse.json({ error: `candidate query failed: ${error.message}` });',
      'const stack = err instanceof Error ? err.stack : undefined;',
      '// return NextResponse.json({ message: e instanceof Error ? e.message : "x" });',
      '/* { detail: err.message } */',
      '/** `${error.message}` */',
      "const accept = 'image/*';",
      'return NextResponse.json({ detail: err.message ?? null });',
      'void reportError(new Error(`org list: ${(error as Error).message}`), { tag: "t" });',
      'if (e instanceof ServiceError) return NextResponse.json({ error: e.code, message: e.message });',
      'return NextResponse.json({',
      '  message: e instanceof Error',
      '    ? e.message',
      "    : 'Unknown error',",
      '});',
    ].join('\n');
    expect(hitsIn('sample.ts', sample).map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5, 10, 14]);
    // A string that looks like a comment's start hides nothing after it.
    expect(
      hitsIn(
        'sample.ts',
        "const a = '/*';\nconst b = { message: rpcErr.message };\nconst c = '*/';",
      ).map((hit) => hit.line),
    ).toEqual([2]);
    // JSX text that looks like a comment is not one, and hides nothing.
    expect(
      hitsIn(
        'sample.tsx',
        'const el = <p>// note</p>;\nconst b = { message: rpcErr.message };',
      ).map((hit) => hit.line),
    ).toEqual([2]);
  });

  it('the census reads every API module and the response helpers outside app/api, and no tests', () => {
    const read = scope().map((file) => path.relative(SRC, file));
    expect(read.length).toBeGreaterThan(200);
    expect(read).toContain('app/api/v1/cycle-counts/[id]/lines/[lineId]/record/route.ts');
    expect(read).toContain('app/api/v1/exceptions/error-response.ts');
    expect(read).toContain('lib/reports/export-errors.ts');
    expect(read).toContain('lib/reports/book-order-totals/http.ts');
    expect(read).toContain('lib/verification/error-response.ts');
    expect(read).toContain('server/lib/order-submission-http.ts');
    // The shared answer itself (server/lib/api-error-response.ts) is read too.
    expect(RESPONSE_HELPER.test('api-error-response.ts')).toBe(true);
    expect(read.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);
  });
});
