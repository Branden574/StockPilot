import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant: no live session id goes out on the public sessions
 * channel (S5, integrator decision 2026-11-01).
 *
 * `user:<id>:sessions` is a public Realtime channel (lib/realtime/broadcast.ts
 * sends `private: false`): anyone holding the anon key and a user's id can
 * read it. "Sign out all other devices" and Change password broadcast
 * `{ keepId: <the session that stays> }`, a LIVE session id, the one thing a
 * member must not learn about another (plans/S35.md). They now broadcast
 * `{ sessionIds: <the sessions they ended> }`, as the phone's sign-out route
 * does, and both listeners read that payload the same way.
 *
 * `keepId: null` ("sign out every session": web Sign out, a password reset, a
 * platform disable) names no session and stays. So in server code every
 * `keepId` must be the literal `keepId: null`; anything else (a variable, a
 * shorthand `{ keepId }`) fails here. Browser modules ('use client', the
 * listener that READS the payload) are out of scope.
 */

const SRC = path.resolve(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/**
 * The code without its comments, so prose that names keepId is not code. A
 * block comment keeps its line breaks, so a reported line is the file's own.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isClientModule(source: string): boolean {
  return /^\s*['"]use client['"]/.test(source);
}

/** Each `keepId` that is not the literal `keepId: null`, as `file:line`. */
function violations(sources: Array<[string, string]>): string[] {
  const out: string[] = [];
  for (const [file, source] of sources) {
    if (isClientModule(source)) continue;
    const body = code(source);
    for (const m of body.matchAll(/\bkeepId\b/g)) {
      const rest = body.slice(m.index! + 'keepId'.length);
      if (/^\s*:\s*null\b/.test(rest)) continue;
      out.push(`${file}:${body.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}

describe('the public sessions channel never carries a live session id', () => {
  it('every keepId in server code is the literal `keepId: null`', () => {
    const sources = files(SRC).map(
      (f) => [path.relative(SRC, f), readFileSync(f, 'utf8')] as [string, string],
    );
    expect(violations(sources)).toEqual([]);
  });

  it('the readers it skips are the browser listener only', () => {
    const readers = files(SRC)
      .map((f) => [path.relative(SRC, f), readFileSync(f, 'utf8')] as const)
      .filter(([, s]) => isClientModule(s) && /\bkeepId\b/.test(code(s)))
      .map(([f]) => f);
    expect(readers).toEqual(['components/realtime/session-revocation-listener.tsx']);
  });

  it('control: it finds a kept id, a shorthand and a variable, in code and not in comments', () => {
    const planted: Array<[string, string]> = [
      ['a.ts', "await broadcastToChannel(t, 'revoked', { keepId: keep });"],
      ['b.ts', "const keepId = id;\nawait broadcastToChannel(t, 'revoked', { keepId });"],
      [
        'c.ts',
        "// keepId: keep\n/* { keepId } */\nawait broadcastToChannel(t, 'revoked', { keepId: null });",
      ],
      ['d.ts', 'const payload: { keepId: null; reason?: string } = { keepId: null };'],
      ['e.tsx', "'use client';\nconst targeted = p.keepId !== mine;"],
      [
        'f.ts',
        "/* a comment\n   over two lines */\nawait broadcastToChannel(t, 'revoked', { keepId: keep });",
      ],
    ];
    expect(violations(planted)).toEqual(['a.ts:1', 'b.ts:1', 'b.ts:2', 'f.ts:3']);
  });
});
