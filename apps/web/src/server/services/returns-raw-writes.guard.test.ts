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

/** Each `.from('<table>')` chain of these tables, up to the end of its statement. */
export function returnTableChains(src: string): string[] {
  const chains: string[] = [];
  const re = /\.from\(\s*(['"`])(returns|return_lines)\1\s*\)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const rest = src.slice(m.index);
    const end = rest.search(/;|\n\s*\n/);
    chains.push(end < 0 ? rest : rest.slice(0, end));
  }
  return chains;
}

const WRITE = /\.(insert|update|upsert|delete)\s*\(/;

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
    const writers = FILES.filter((f) => returnTableChains(readFileSync(f, 'utf8')).some((c) => WRITE.test(c)));
    expect(writers.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('no product file calls the frozen wrapper process_return_disposition (close_return is the one close)', () => {
    const callers = FILES.filter((f) => /rpc\(\s*['"`]process_return_disposition['"`]/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => path.relative(REPO, f))).toEqual([]);
  });

  it('the scanner catches a write written across lines (its own control)', () => {
    const planted = "await admin\n  .from('returns')\n  .update({ status: 'closed' })\n  .eq('id', id);";
    expect(returnTableChains(planted).some((c) => WRITE.test(c))).toBe(true);
    const read = "await sb\n  .from('return_lines')\n  .select('id')\n  .eq('return_id', id);";
    expect(returnTableChains(read).some((c) => WRITE.test(c))).toBe(false);
  });
});
