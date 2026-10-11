import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * RETURNS ARE WRITTEN ONLY BY THEIR DATABASE FUNCTIONS (returns RX-4, the
 * contract, migration 0398). Since RX-1 every RMA transition is a gated
 * SECURITY DEFINER function, and since RX-4 an API role holds SELECT only on
 * returns and return_lines. Product code must therefore never write either
 * table through a client: a write through the user's client would now fail
 * with 42501, and one through the admin client would skip every gate, the
 * decision log, the audit and the notifications the functions keep. RX-1
 * deleted the last two (RMAService.applyTransition and the requester create's
 * compensating delete, #322); this guard keeps them gone.
 *
 * It scans every product source file of the web app, the phone and core
 * (tests excluded) for a `.from('returns')` or `.from('return_lines')` chain
 * that writes (insert, update, upsert, delete), and for a call of the frozen
 * 0359 wrapper process_return_disposition (close_return is the one path).
 * Since RX-4 fix round 1 (desk check security S1) it also catches the table
 * name written `as const` or bound to a variable, a chain bound to a variable
 * and written later, a `;` in a comment inside a chain, and any raw
 * PostgREST URL of either table. It stays a source scan: code that builds the
 * table name at run time is out of its reach (0398 refuses an API role at the
 * database whatever the code; the admin client is the residual).
 */

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages/core/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => sourceFiles(path.join(REPO, r)));

/**
 * The source with its comments blanked (a `;` in a trailing comment no longer
 * ends a chain early). Only a comment that starts a line or follows white
 * space counts, so a URL (`https://`) or a glob (`'**\/*.ts'`) in a string is
 * kept.
 */
function stripComments(src: string): string {
  return src.replace(/(^|\s)\/\*[\s\S]*?\*\//gm, '$1 ').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

/** A return table's name as a literal (a named group, so it composes). */
const TABLE_LITERAL = String.raw`(?<q>['"\x60])(?:returns|return_lines)\k<q>(?:\s+as\s+const)?`;

/** Names a file binds to a return table's name (`const T = 'returns'`). */
function tableNames(src: string): string[] {
  const re = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*` + TABLE_LITERAL + String.raw`\s*[;,\n]`, 'g');
  return [...src.matchAll(re)].map((m) => m[1]!);
}

/** The pattern of `.from(<a return table>)`: its name as a literal, or a name bound to it. */
function fromPattern(names: string[]): RegExp {
  const ref = [TABLE_LITERAL, ...names.map((n) => `${n}\\b`)].join('|');
  return new RegExp(String.raw`\.from\(\s*(?:` + ref + String.raw`)\s*\)`, 'g');
}

/** Each `.from(<a return table>)` chain, up to the end of its statement. */
export function returnTableChains(raw: string): string[] {
  const src = stripComments(raw);
  const chains: string[] = [];
  const re = fromPattern(tableNames(src));
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const rest = src.slice(m.index);
    const end = rest.search(/;|\n\s*\n/);
    chains.push(end < 0 ? rest : rest.slice(0, end));
  }
  return chains;
}

const WRITE = /\.(insert|update|upsert|delete)\s*\(/;

/**
 * The writes of the return tables a source file makes: a `.from(...)` chain
 * that writes (the table named by a literal, `as const` or not, or by a name
 * bound to it), a chain bound to a variable that is written later
 * (`const q = admin.from('returns'); q.update(...)`), and any raw PostgREST
 * URL of either table (RX-4 fix round 1, desk check security S1).
 */
export function returnTableWrites(raw: string): string[] {
  const src = stripComments(raw);
  const out = returnTableChains(raw).filter((c) => WRITE.test(c));
  const from = fromPattern(tableNames(src)).source;
  const bound = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:await\s+)?[\w.$]+(?:\s*\.\s*\w+\([^()]*\))*\s*` + from, 'g');
  for (const m of src.matchAll(bound)) {
    const name = m[1]!;
    const written = new RegExp(String.raw`\b${name}\s*\.\s*(?:insert|update|upsert|delete)\s*\(`);
    if (written.test(src.slice(m.index + m[0].length))) out.push(`${name} = ${m[0].trim()}`);
  }
  for (const m of src.matchAll(/\/rest\/v1\/(?:returns|return_lines)\b/g)) out.push(m[0]);
  return out;
}

describe('nothing in product code writes an RMA but its database functions', () => {
  it('scans a real tree, the RMA service and the phone included', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.endsWith('apps/web/src/server/services/returns.ts'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('apps/mobile/app/order/[id].tsx'))).toBe(true);
  });

  it('finds the reads it is meant to allow (the scan is not empty)', () => {
    const reads = FILES.flatMap((f) => returnTableChains(readFileSync(f, 'utf8')));
    expect(reads.length).toBeGreaterThan(10);
  });

  it('no product file inserts, updates, upserts or deletes returns or return_lines through a client', () => {
    const writers = FILES.filter((f) => returnTableWrites(readFileSync(f, 'utf8')).length > 0);
    expect(writers.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('no product file calls the frozen wrapper process_return_disposition (close_return is the one close)', () => {
    const callers = FILES.filter((f) => /rpc\(\s*['"`]process_return_disposition['"`]/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  // RX-4 fix round 1 (desk check security S1): the shapes a literal-only scan
  // missed. Each must be caught; the reads beside them must not.
  it.each([
    ['a plain chain', "await admin.from('returns').insert({ status: 'requested' });"],
    ['double quotes', 'await admin.from("return_lines").delete().eq("id", id);'],
    ['through .schema()', "await admin.schema('public').from('returns').update({ status: 'closed' }).eq('id', id);"],
    ['an `as const` table name', "await admin.from('returns' as const).delete().eq('id', id);"],
    ['a table name bound to a variable', "const T = 'returns';\nawait admin.from(T).update({ status: 'closed' }).eq('id', id);"],
    ['a chain bound to a variable, written later', "const q = admin.from('return_lines');\nawait q.upsert({ id });"],
    ['a semicolon in a comment inside the chain', "await admin\n  .from('returns') // keep it; really\n  .update({ status: 'closed' })\n  .eq('id', id);"],
    ['a raw PostgREST URL', "await fetch(`${url}/rest/v1/returns`, { method: 'POST', body });"],
  ])('the scanner catches %s (its own control)', (_label, planted) => {
    expect(returnTableWrites(planted)).not.toEqual([]);
  });

  it.each([
    ['a read chain', "await sb.from('returns').select('id').eq('id', id);"],
    ['a read through a bound name', "const T = 'return_lines';\nawait sb.from(T).select('id');"],
    ['a read chain bound to a variable', "const q = sb.from('returns').select('id');\nconst { data } = await q;"],
    ['another endpoint', "await fetch(`${url}/rest/v1/rpc/close_return`, { method: 'POST' });"],
  ])('the scanner lets %s through (its own control)', (_label, planted) => {
    expect(returnTableWrites(planted)).toEqual([]);
  });

  it('the scanner catches a write written across lines (its own control)', () => {
    const planted = "await admin\n  .from('returns')\n  .update({ status: 'closed' })\n  .eq('id', id);";
    expect(returnTableChains(planted).some((c) => WRITE.test(c))).toBe(true);
    const read = "await sb\n  .from('return_lines')\n  .select('id')\n  .eq('return_id', id);";
    expect(returnTableChains(read).some((c) => WRITE.test(c))).toBe(false);
  });
});
