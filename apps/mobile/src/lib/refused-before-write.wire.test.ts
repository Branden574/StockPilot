import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_UNAVAILABLE_COPY,
  ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY,
  contextUnavailableBody,
  isRefusedBeforeAnyWrite,
} from '@stockpilot/core';

import { adjustDrainVerdict } from './adjust-outbox';
import { api, ApiError } from './api';
import { describeEscalateError } from './exception-escalation';
import { classifyAdjustFailure } from './item-adjust';
import { rentalCheckoutFailure } from './rental-view';

/**
 * REFUSED BEFORE ANY WRITE, FROM THE WIRE TO EVERY READER (docket S26).
 *
 * The server's API context gate answers a 503 whose body is core
 * contextUnavailableBody() when it refused a request before doing anything,
 * because the caller's access could not be checked (the gate's own test pins
 * that its answer is exactly that body). Here the REAL api() reads that answer
 * off a stubbed fetch, and the ApiError it throws is handed to the four
 * readers that act on it: the online adjustment, the queued adjustment, the
 * rental checkout and the exception escalation. Each one must read it as
 * nothing written, and none may read the other check_failed answers (an
 * unreadable warehouse access, account delete) or a bare 503 that way: those
 * prove nothing about writes, and the adjustment and checkout routes take no
 * idempotency key.
 *
 * Then a guard (recurring pattern #26, one predicate and no copies): no
 * non-test phone code spells the marker's code, reason or flag. The phone
 * reads it only through core's isRefusedBeforeAnyWrite, so a second, looser
 * reading cannot appear beside it.
 */

// api() resolves its base URL AT LOAD and reads React Native's __DEV__, so this
// must run before the imports above: vitest hoists vi.hoisted and vi.mock above
// every import (the same setup as api-error-details.test.ts).
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));

function respondWith(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    })),
  );
}

/** What the real api() throws for this answer to a POST. */
async function thrownFor(status: number, body: string): Promise<unknown> {
  respondWith(status, body);
  return api('/api/v1/items/i1/adjust', { method: 'POST', body: { quantityChange: 1 } }).then(
    () => {
      throw new Error('api() resolved on an error status');
    },
    (e: unknown) => e,
  );
}

/** What each of the four readers makes of one error. */
function readings(err: unknown) {
  return {
    predicate: isRefusedBeforeAnyWrite(err),
    online: classifyAdjustFailure(err).kind,
    queued: adjustDrainVerdict(err, { accountDisabled: false, handedOff: true }),
    checkout: rentalCheckoutFailure(err, true).title,
    escalation: describeEscalateError(err).retryable,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('the marker, from the real api() to every reader', () => {
  it('the core body as a 503 is read as nothing written by all four', async () => {
    const err = await thrownFor(503, JSON.stringify(contextUnavailableBody()));

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(CONTEXT_UNAVAILABLE_COPY);
    expect(readings(err)).toEqual({
      predicate: true,
      online: 'refused',
      queued: 'refused-before-write',
      checkout: 'Could not check out',
      escalation: true,
    });
    expect(classifyAdjustFailure(err)).toEqual({
      kind: 'refused',
      alert: { title: 'Adjustment not saved', message: CONTEXT_UNAVAILABLE_COPY },
    });
  });

  // What every reader does today with a 5xx it cannot vouch for.
  const UNPROVEN = {
    predicate: false,
    online: 'unconfirmed',
    queued: 'unconfirmed',
    checkout: 'Checkout not confirmed',
    escalation: false,
  };

  it.each([
    [
      'the unreadable warehouse access 503 (S16)',
      503,
      JSON.stringify({ error: 'check_failed', message: ORDER_WAREHOUSE_ACCESS_UNREADABLE_COPY }),
    ],
    [
      "account delete's 503",
      503,
      JSON.stringify({
        error: 'check_failed',
        message:
          'Your account could not be deleted right now. Nothing was changed. Try again in a minute.',
      }),
    ],
    ['a bare 503 with no JSON (an edge or a gateway)', 503, '<!doctype html><title>503</title>'],
    ['the core body with a 500', 500, JSON.stringify(contextUnavailableBody())],
    ['the core body with a 502', 502, JSON.stringify(contextUnavailableBody())],
    [
      'the core body with nothingWritten false',
      503,
      JSON.stringify({
        ...contextUnavailableBody(),
        details: { ...contextUnavailableBody().details, nothingWritten: false },
      }),
    ],
  ])('%s is read as unproven by every reader', async (_label, status, body) => {
    const err = await thrownFor(status, body);
    expect(err).toBeInstanceOf(ApiError);
    expect(readings(err)).toEqual(UNPROVEN);
  });
});

/* ───────────── guard: the phone reads the marker only through core ───────────── */

const MOBILE = path.resolve(__dirname, '../..');
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__fixtures__', '__mocks__']);

/** The marker's own words: its code, its reason and its flag. */
const MARKER_WORDS = ['check_failed', 'context_unavailable', 'nothingWritten'];

/** Every non-test source file of the shipped phone code (src and app), MOBILE-relative. */
function phoneSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
      } else if (SOURCE_FILE.test(name) && !TEST_FILE.test(name)) {
        out.set(path.relative(MOBILE, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(MOBILE, 'src'));
  walk(path.join(MOBILE, 'app'));
  return out;
}

/**
 * Where code spells one of MARKER_WORDS: an identifier spelled so, or string or
 * template text containing it. Read on the syntax tree, so a comment that
 * explains the marker never counts.
 */
function markerSpellings(files: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [file, src] of files) {
    const sf = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (n: ts.Node): void => {
      let text: string | null = null;
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) text = n.text;
      else if (
        ts.isStringLiteralLike(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n) ||
        ts.isJsxText(n)
      ) {
        text = n.text;
      }
      if (text !== null) {
        for (const word of MARKER_WORDS) {
          const hit =
            ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? text === word : text.includes(word);
          if (hit) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            found.push(`${file}:${line} ${word}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

describe('the phone reads the marker only through core (one predicate, no copies)', () => {
  const FILES = phoneSources();

  it('reads the real phone code', () => {
    expect(FILES.size).toBeGreaterThan(300);
    for (const known of [
      'src/lib/item-adjust.ts',
      'src/lib/adjust-outbox.ts',
      'src/lib/rental-view.ts',
      'src/lib/exception-escalation.ts',
      'app/(drawer)/(tabs)/scan.tsx',
    ]) {
      expect(FILES.has(known), known).toBe(true);
    }
    // Each reader does call core's predicate.
    for (const reader of [
      'src/lib/item-adjust.ts',
      'src/lib/adjust-outbox.ts',
      'src/lib/rental-view.ts',
      'src/lib/exception-escalation.ts',
    ]) {
      expect(FILES.get(reader), reader).toMatch(/isRefusedBeforeAnyWrite\(/);
    }
  });

  it("no non-test phone code spells the marker's code, reason or flag", () => {
    expect(markerSpellings(FILES)).toEqual([]);
  });

  it('plants: a copied check is found, in a string, a key or a template; a comment is not', () => {
    const planted = new Map([
      [
        'src/lib/planted.ts',
        `export const own = (e: any) => e.status === 503 && e.code === 'check_failed';`,
      ],
      ['src/lib/planted-two.ts', 'export const flag = (d: any) => d.nothingWritten === true;'],
      ['app/planted.tsx', 'export const r = `reason ${"x"}:context_unavailable`;'],
      [
        'src/lib/commented.ts',
        '// the marker is 503 check_failed with nothingWritten\nexport const n = 1;',
      ],
    ]);
    expect(markerSpellings(planted)).toEqual([
      'src/lib/planted.ts:1 check_failed',
      'src/lib/planted-two.ts:1 nothingWritten',
      'app/planted.tsx:1 context_unavailable',
    ]);
  });
});
