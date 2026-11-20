// Security invariant (listed in scripts/security-test.sh): the app's rule for
// posting and reversing a receipt is the database's, for every role and
// override the database's own test tries.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  canPostReceipt,
  effectivePermissions,
  PERMISSIONS,
  RECEIVE_MANAGER_ONLY_COPY,
  REVERSE_MANAGER_ONLY_COPY,
  ROLES,
  type Permission,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

import { makeServiceContext } from '@/test/supabase-mock';

import { assertCanPostReceipt, assertCanReverseReceipt } from './receipt-post-rule';

/**
 * supabase/tests/receipt_post_rule.test.sql runs post_receipt_v2, then
 * reverse_receipt on a posted receipt, as one member per row of its case
 * table and checks the database's answers against the row's `posts` and
 * `answer`, `reverses` and `reverse_answer`. This file reads that same table
 * and checks the app's side against every row: core canPostReceipt (the web
 * page and the phone), assertCanPostReceipt (ReceivingService.postReceipt and
 * the receive-line route) and assertCanReverseReceipt
 * (ReceivingService.reverseReceipt). A row changed there changes here.
 */

interface RuleCase {
  n: number;
  who: string;
  role: Role;
  /** The member's own overrides (user_permission_overrides). */
  grants: Permission[];
  revokes: Permission[];
  /** Organization-wide overrides for the member's role (role_permission_overrides). */
  roleGrants: Permission[];
  roleRevokes: Permission[];
  posts: boolean;
  answer: string;
  reverses: boolean;
  reverseAnswer: string;
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
      /^\s*\(\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*(true|false),\s*'([^']*)',\s*(true|false),\s*'([^']*)'\)[,;]\s*$/.exec(
        line,
      );
    expect(m, `a case row: ${line}`).not.toBeNull();
    return {
      n: Number(m![1]),
      who: m![2]!,
      role: m![3] as Role,
      grants: list(m![4]!),
      revokes: list(m![5]!),
      roleGrants: list(m![6]!),
      roleRevokes: list(m![7]!),
      posts: m![8] === 'true',
      answer: m![9]!,
      reverses: m![10] === 'true',
      reverseAnswer: m![11]!,
    };
  });
}

const CASES = readCases(SQL);

function overrides(grants: Permission[], revokes: Permission[]): PermissionOverride[] {
  return [
    ...grants.map((permission) => ({ permission, granted: true })),
    ...revokes.map((permission) => ({ permission, granted: false })),
  ];
}

describe('the database test case table', () => {
  it('is read whole: numbered 1..n, every role, only known permissions, posts matches answer and reverses matches reverse_answer', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(17);
    expect(CASES.map((c) => c.n)).toEqual(CASES.map((_, i) => i + 1));
    expect([...new Set(CASES.map((c) => c.role))].sort()).toEqual([...ROLES].sort());
    for (const c of CASES) {
      for (const p of [...c.grants, ...c.revokes, ...c.roleGrants, ...c.roleRevokes]) {
        expect(PERMISSIONS as readonly string[], `${c.who}: ${p}`).toContain(p);
      }
      expect(c.answer === 'ok:1', c.who).toBe(c.posts);
      expect(c.reverseAnswer === 'ok:1', c.who).toBe(c.reverses);
    }
  });

  it('tries the owner without stock:adjust, and organization-wide role overrides', () => {
    expect(CASES.some((c) => c.role === 'owner' && c.revokes.includes('stock:adjust'))).toBe(true);
    expect(CASES.some((c) => c.roleRevokes.includes('stock:adjust'))).toBe(true);
    expect(CASES.some((c) => c.roleGrants.includes('purchase_orders:manage'))).toBe(true);
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
      // The server's own resolution (lib/auth/effective-permissions.ts): the
      // role's organization-wide overrides, then the member's, which win.
      const permissions = effectivePermissions(
        c.role,
        overrides(c.roleGrants, c.roleRevokes),
        overrides(c.grants, c.revokes),
      );
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

describe('the app asks the rule the database applies to a reversal, case by case', () => {
  for (const c of CASES) {
    it(`${c.n}. ${c.who}: ${c.reverses ? 'reverses' : 'refused'}`, () => {
      const permissions = effectivePermissions(
        c.role,
        overrides(c.roleGrants, c.roleRevokes),
        overrides(c.grants, c.revokes),
      );
      // The web's Reverse and the service ask the receipt rule.
      expect(canPostReceipt({ role: c.role, permissions })).toBe(c.reverses);

      const ctx = makeServiceContext(null, { role: c.role, permissions });
      let refusal: unknown = null;
      try {
        assertCanReverseReceipt(ctx as never);
      } catch (e) {
        refusal = e;
      }
      if (c.reverses) {
        expect(refusal).toBeNull();
      } else {
        expect(refusal).toMatchObject({ code: 'forbidden' });
        expect((refusal as { details?: unknown }).details).toBeUndefined();
        expect((refusal as Error).message).toBe(
          c.reverseAnswer === '42501:permission'
            ? 'Missing permission: stock:adjust'
            : REVERSE_MANAGER_ONLY_COPY,
        );
      }
    });
  }
});
