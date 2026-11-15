import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModulesUnavailableError } from './module-state';
import { orgMayUseModule } from './org-may-use-module';

/**
 * The single-module ACCESS check used where there is no user context (the
 * public API-key path on the service-role client, the public webhook
 * subscriptions, the accounting connect callbacks). It must agree with the
 * one rule, and it has three answers: on, off, and "could not be read", which
 * is thrown (ModulesUnavailableError) and never returned as off. It never
 * grants on a read that did not answer.
 */

type Answer = { data: unknown; error: unknown };

function client(opts: { rows: Answer; org: Answer }) {
  const asked: string[] = [];
  const chains: Record<string, unknown[][]> = {};
  return {
    asked,
    chains,
    from(table: string) {
      asked.push(table);
      const calls: unknown[][] = (chains[table] = []);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'limit']) {
        q[m] = (...args: unknown[]) => {
          calls.push([m, ...args]);
          return q;
        };
      }
      q.then = (ok: (v: Answer) => unknown) =>
        Promise.resolve(table === 'organization_modules' ? opts.rows : opts.org).then(ok);
      return q;
    },
  };
}

const rows = (...r: Array<{ enabled: boolean }>): Answer => ({ data: r, error: null });
const org = (comp: boolean): Answer => ({ data: [{ all_modules_comp: comp }], error: null });
const FAILED: Answer = { data: null, error: { message: 'upstream timeout', code: '57014' } };
const EMPTY_BODY: Answer = { data: null, error: null };

const may = (c: ReturnType<typeof client>) => orgMayUseModule(c as never, 'org-1', 'api_access');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('orgMayUseModule: both reads answered', () => {
  it('an explicit enabled row is enough', async () => {
    expect(await may(client({ rows: rows({ enabled: true }), org: org(false) }))).toBe(true);
  });

  it('no row and no comp: off', async () => {
    expect(await may(client({ rows: rows(), org: org(false) }))).toBe(false);
  });

  it('a row that says off and no comp: off', async () => {
    expect(await may(client({ rows: rows({ enabled: false }), org: org(false) }))).toBe(false);
  });

  it('a COMPED organization has the module with no row at all', async () => {
    expect(await may(client({ rows: rows(), org: org(true) }))).toBe(true);
  });

  it('the comp wins over an explicit OFF row, which is the ordinary state of a comped organization', async () => {
    expect(await may(client({ rows: rows({ enabled: false }), org: org(true) }))).toBe(true);
  });

  it('reads exactly the two tables the rule needs, each as a list bounded to one row', async () => {
    const c = client({ rows: rows(), org: org(false) });
    await may(c);
    expect(c.asked.sort()).toEqual(['organization_modules', 'organizations']);
    expect(c.chains.organization_modules).toEqual([
      ['select', 'enabled'],
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'module_id', 'api_access'],
      ['limit', 1],
    ]);
    expect(c.chains.organizations).toEqual([
      ['select', 'all_modules_comp'],
      ['eq', 'id', 'org-1'],
      ['limit', 1],
    ]);
  });
});

describe('orgMayUseModule: a read that did not answer', () => {
  it('what WAS read still grants: an enabled row beside an unread flag, a comp beside unread rows', async () => {
    expect(await may(client({ rows: rows({ enabled: true }), org: FAILED }))).toBe(true);
    expect(await may(client({ rows: FAILED, org: org(true) }))).toBe(true);
  });

  it.each([
    ['the rows read failed', { rows: FAILED, org: org(false) }],
    ['the flag read failed', { rows: rows(), org: FAILED }],
    ['the flag read failed beside a row that says off', { rows: rows({ enabled: false }), org: FAILED }],
    ['both reads failed', { rows: FAILED, org: FAILED }],
    ['the rows answer is an empty body', { rows: EMPTY_BODY, org: org(false) }],
    ['the flag answer is an empty body', { rows: rows(), org: EMPTY_BODY }],
    ['a row without a boolean enabled', { rows: { data: [{}], error: null }, org: org(false) }],
    ['no organization row: the flag was never seen', { rows: rows(), org: { data: [], error: null } }],
    [
      'an organization row whose flag is not a boolean',
      { rows: rows(), org: { data: [{ all_modules_comp: null }], error: null } },
    ],
  ] as Array<[string, { rows: Answer; org: Answer }]>)(
    '%s: neither on nor off, the try-again error',
    async (_name, answers) => {
      const asked = may(client(answers));
      await expect(asked).rejects.toBeInstanceOf(ModulesUnavailableError);
      await expect(asked).rejects.toThrow('Your access could not be checked. Please try again.');
    },
  );

  it('never grants on a read that did not answer', async () => {
    // Nothing a failed read could carry is read as "on".
    const unread: Answer = { data: [{ enabled: true }], error: { message: 'partial', code: 'X' } };
    await expect(may(client({ rows: unread, org: org(false) }))).rejects.toBeInstanceOf(
      ModulesUnavailableError,
    );
    const unreadComp: Answer = {
      data: [{ all_modules_comp: true }],
      error: { message: 'partial', code: 'X' },
    };
    await expect(may(client({ rows: rows(), org: unreadComp }))).rejects.toBeInstanceOf(
      ModulesUnavailableError,
    );
  });
});
