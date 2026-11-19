// Security invariant (listed in scripts/security-test.sh): the app's rule for
// posting a receipt is the database's, for every role and override the
// database's own test tries.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  canPostReceipt,
  effectivePermissions,
  PERMISSIONS,
  RECEIVE_MANAGER_ONLY_COPY,
  ROLES,
  type Permission,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

import { makeServiceContext } from '@/test/supabase-mock';

import { assertCanPostReceipt } from './receipt-post-rule';

/**
 * supabase/tests/receipt_post_rule.test.sql runs post_receipt_v2 as one member
 * per row of its case table and checks the database's answer against the
 * row's `posts` and `answer`. This file reads that same table and checks the
 * app's side against every row: core canPostReceipt (the web page and the
 * phone) and assertCanPostReceipt (ReceivingService.postReceipt and the
 * receive-line route). A row changed there changes here.
 */

interface RuleCase {
  n: number;
  who: string;
  role: Role;
  grants: Permission[];
  revokes: Permission[];
  posts: boolean;
  answer: string;
}

const SQL = readFileSync(
  resolve(__dirname, '../../../../../../supabase/tests/receipt_post_rule.test.sql'),
  'utf8',
);

function list(csv: string): Permission[] {
  return csv === '' ? [] : (csv.split(',') as Permission[]);
}

function readCases(sql: string): RuleCase[] {
  const begin = sql.indexOf('-- RULE CASES BEGIN');
  const end = sql.indexOf('-- RULE CASES END');
  expect(begin, 'the table start marker').toBeGreaterThan(-1);
  expect(end, 'the table end marker').toBeGreaterThan(begin);
  const rows = sql
    .slice(begin, end)
    .split('\n')
    .filter((l) => /^\s*\(/.test(l));
  return rows.map((line) => {
    const m =
      /^\s*\(\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*(true|false),\s*'([^']*)'\)[,;]\s*$/.exec(
        line,
      );
    expect(m, `a case row: ${line}`).not.toBeNull();
    return {
      n: Number(m![1]),
      who: m![2]!,
      role: m![3] as Role,
      grants: list(m![4]!),
      revokes: list(m![5]!),
      posts: m![6] === 'true',
      answer: m![7]!,
    };
  });
}

const CASES = readCases(SQL);

function overridesOf(c: RuleCase): PermissionOverride[] {
  return [
    ...c.grants.map((permission) => ({ permission, granted: true })),
    ...c.revokes.map((permission) => ({ permission, granted: false })),
  ];
}

describe('the database test case table', () => {
  it('is read whole: numbered 1..n, every role, only known permissions, and posts matches answer', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(13);
    expect(CASES.map((c) => c.n)).toEqual(CASES.map((_, i) => i + 1));
    expect([...new Set(CASES.map((c) => c.role))].sort()).toEqual([...ROLES].sort());
    for (const c of CASES) {
      for (const p of [...c.grants, ...c.revokes]) {
        expect(PERMISSIONS as readonly string[], `${c.who}: ${p}`).toContain(p);
      }
      expect(c.answer === 'ok:1', c.who).toBe(c.posts);
    }
  });

  it('tries staff granted purchase_orders:manage, with stock:adjust and without it', () => {
    const managed = CASES.filter(
      (c) => c.role === 'staff' && c.grants.includes('purchase_orders:manage'),
    );
    expect(managed.some((c) => !c.revokes.includes('stock:adjust'))).toBe(true);
    expect(managed.some((c) => c.revokes.includes('stock:adjust'))).toBe(true);
  });
});

describe('the app asks the rule the database applies, case by case', () => {
  for (const c of CASES) {
    it(`${c.n}. ${c.who}: ${c.posts ? 'posts' : 'refused'}`, () => {
      const permissions = effectivePermissions(c.role, [], overridesOf(c));
      expect(canPostReceipt({ role: c.role, permissions })).toBe(c.posts);

      const ctx = makeServiceContext(null, { role: c.role, permissions });
      let refusal: unknown = null;
      try {
        assertCanPostReceipt(ctx as never);
      } catch (e) {
        refusal = e;
      }
      if (c.posts) {
        expect(refusal).toBeNull();
      } else {
        expect(refusal).toMatchObject({ code: 'forbidden' });
        // The database's refusal of the permission (hint permission) is the
        // app's missing-permission answer; every other refusal is the role's.
        expect((refusal as Error).message).toBe(
          c.answer === '42501:permission'
            ? 'Missing permission: stock:adjust'
            : RECEIVE_MANAGER_ONLY_COPY,
        );
      }
    });
  }
});
