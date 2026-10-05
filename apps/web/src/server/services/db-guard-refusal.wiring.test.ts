import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Migration 0395 (L8) gates six stock ledger functions on the permission the
 * app checks first and refuses with 42501 'forbidden', hint permission. The
 * message is the same word the functions' role floors raise, so each call
 * site must ask dbGuardRefusal BEFORE its own arms: an `includes('forbidden')`
 * arm reached first would put the wrong sentence on the refusal ("You cannot
 * reverse this receipt", a warehouse refusal). adjust, transfer and cancel
 * are proven by behaviour (inventory.db-guard.test.ts,
 * order-requests.db-guard.test.ts); this pins the other four call sites by
 * their source: the guard, with its action, is the first thing in the RPC's
 * error branch.
 */

const DIR = __dirname;

function errorBranch(file: string, rpc: string): string {
  const src = readFileSync(join(DIR, file), 'utf8');
  const call = src.indexOf(`rpc('${rpc}'`);
  expect(call, `${file} calls ${rpc}`).toBeGreaterThan(-1);
  const open = src.indexOf('if (error) {', call);
  expect(open, `${file}: the ${rpc} error branch`).toBeGreaterThan(call);
  return src.slice(open, open + 1200);
}

function firstStatement(branch: string): string {
  // Skip the comment lines; the first code line of the branch.
  return (
    branch
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('//')) ?? ''
  );
}

describe('0395: each gated RPC asks dbGuardRefusal first in its error branch', () => {
  const sites: Array<[string, string, string, RegExp]> = [
    ['cycle-counts.ts', 'post_cycle_count', 'count_post',
      /^throw dbGuardRefusal\(error, 'count_post'\) \?\? mapPostCycleCountError\(/],
    ['receiving.ts', 'post_receipt_v2', 'receipt_post', /^const guard = dbGuardRefusal\(error, 'receipt_post'\);$/],
    ['receiving.ts', 'reverse_receipt', 'receipt_reverse', /^const guard = dbGuardRefusal\(error, 'receipt_reverse'\);$/],
    ['bundles.ts', 'assemble_bundle', 'kit_assemble', /^const guard = dbGuardRefusal\(error, 'kit_assemble'\);$/],
    ['inventory.ts', 'adjust_stock', 'adjust', /^const guard = dbGuardRefusal\(error, 'adjust'\);$/],
    ['inventory.ts', 'transfer_stock', 'transfer', /^const guard = dbGuardRefusal\(error, 'transfer'\);$/],
    ['order-requests.ts', 'cancel_order_request', 'none', /^const guard = dbGuardRefusal\(error\);$/],
  ];
  for (const [file, rpc, action, first] of sites) {
    it(`${file} ${rpc} (${action})`, () => {
      const branch = errorBranch(file, rpc);
      expect(firstStatement(branch)).toMatch(first);
      if (!first.source.startsWith('^throw')) {
        // The guard is thrown on the very next line, before any other arm.
        const lines = branch.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
        expect(lines[2]).toBe('if (guard) throw guard;');
      }
    });
  }
});
