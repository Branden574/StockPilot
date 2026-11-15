import * as fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCallGraph, shippedSourceFiles } from '@/test/gate-reach';

import {
  AUTHENTICATOR_SET_UP_PAGE,
  AUTHENTICATOR_SET_UP_URL,
  OPEN_BEFORE_AUTHENTICATOR_SET_UP,
  openBeforeAuthenticatorSetUp,
} from './authenticator-set-up';

/**
 * Security invariant: a member who must set up an authenticator first is held
 * to it on every dashboard page and every Server Action that builds on their
 * context, with one list of the pages open to them before set-up.
 *
 *   1. requireOrgContext() asks the set-up question (authenticatorSetUpIsOwed
 *      in lib/auth/step-up-gate). Every dashboard page and layout asks
 *      requireOrgContext() before anything else it reads
 *      (test/page-step-up.guard.test.ts), so each page carries the rule by
 *      itself, whether or not the dashboard layout ran for the request.
 *   2. The dashboard layout uses the same rule (authenticatorSetUpOwed from
 *      @stockpilot/core) and the same list of open pages.
 *   3. Nothing else decides which pages are open: no file writes its own
 *      prefix test for the security page, which would also let through any
 *      sibling path that starts with the same letters.
 *   4. The open pages are the security page and the profile page, matched
 *      exactly or below them after a slash.
 *   5. Signing out never asks for the member's context, so it works from any
 *      page, set-up owed or not.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const FILES = shippedSourceFiles(WEB_SRC, fs);
const GRAPH = buildCallGraph(FILES, WEB_SRC);
const abs = (rel: string) => path.join(WEB_SRC, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');

describe('authenticator set-up comes first', () => {
  it('1. requireOrgContext() asks the set-up question', () => {
    const reach = GRAPH.reach([`${abs('lib/auth/step-up-gate.ts')}#authenticatorSetUpIsOwed`]);
    expect(reach.exportReaches(abs('lib/auth/session.ts'), 'requireOrgContext')).toBe(true);
    // And the question is the core rule.
    expect(read('lib/auth/step-up-gate.ts')).toMatch(/authenticatorSetUpOwed\(/);
  });

  it('2. the dashboard layout uses the same rule and the same list of open pages', () => {
    const layout = read('app/(dashboard)/layout.tsx');
    expect(layout).toMatch(/authenticatorSetUpOwed\(/);
    expect(layout).toMatch(/openBeforeAuthenticatorSetUp\(/);
    expect(layout).toMatch(/redirect\(AUTHENTICATOR_SET_UP_URL\)/);
  });

  it('3. no other file writes its own prefix test for the security page', () => {
    const own = 'lib/auth/authenticator-set-up.ts';
    const offenders = FILES.map((f) => path.relative(WEB_SRC, f.path).split(path.sep).join('/'))
      .filter((rel) => rel !== own)
      .filter((rel) =>
        /startsWith\(\s*['"`]\/dashboard\/settings\/(security|profile)/.test(read(rel)),
      );
    expect(offenders).toEqual([]);
  });

  it('4. the open pages: the security page and the profile page, exactly or below after a slash', () => {
    expect(OPEN_BEFORE_AUTHENTICATOR_SET_UP).toEqual([
      '/dashboard/settings/security',
      '/dashboard/settings/profile',
    ]);
    expect(AUTHENTICATOR_SET_UP_URL).toBe(`${AUTHENTICATOR_SET_UP_PAGE}?enroll=1`);
    for (const open of [
      '/dashboard/settings/security',
      '/dashboard/settings/security/',
      '/dashboard/settings/security/anything',
      '/dashboard/settings/profile',
    ]) {
      expect(openBeforeAuthenticatorSetUp(open), open).toBe(true);
    }
    for (const closed of [
      null,
      undefined,
      '',
      '/',
      '/dashboard',
      '/dashboard/settings',
      '/dashboard/settings/security-keys',
      '/dashboard/settings/securityx',
      '/dashboard/settings/profile-old',
      '/dashboard/settings/security?enroll=1',
      '/x/dashboard/settings/security',
    ]) {
      expect(openBeforeAuthenticatorSetUp(closed), String(closed)).toBe(false);
    }
  });

  it('5. signing out never asks for the member context', () => {
    const reach = GRAPH.reach([`${abs('lib/auth/session.ts')}#requireOrgContext`]);
    expect(reach.exportReaches(abs('server/actions/auth.ts'), 'signOutAction')).toBe(false);
    expect(reach.exportReaches(abs('server/actions/mfa.ts'), 'enrollFactorAction')).toBe(false);
    // Control: an action that does ask is seen as asking.
    expect(
      reach.exportReaches(abs('server/actions/org-switcher.ts'), 'switchOrganizationAction'),
    ).toBe(true);
  });
});
