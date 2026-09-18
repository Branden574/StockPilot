import { describe, expect, it } from 'vitest';

import { orgMayUseModule } from './org-may-use-module';

/**
 * The single-module ACCESS check used where there is no user context (the
 * public API-key path, on the service-role client). It must agree with the one
 * rule, and it must fail CLOSED: this gate stands in front of an organization's
 * whole public API.
 */

function client(opts: {
  row?: { enabled?: boolean } | null;
  rowError?: unknown;
  org?: { all_modules_comp?: boolean | null } | null;
  orgError?: unknown;
}) {
  const asked: string[] = [];
  return {
    asked,
    from(table: string) {
      asked.push(table);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () =>
        table === 'organization_modules'
          ? { data: opts.rowError ? null : (opts.row ?? null), error: opts.rowError ?? null }
          : { data: opts.orgError ? null : (opts.org ?? null), error: opts.orgError ?? null };
      return q;
    },
  };
}

const may = (c: ReturnType<typeof client>) => orgMayUseModule(c as never, 'org-1', 'api_access');

describe('orgMayUseModule', () => {
  it('an explicit enabled row is enough', async () => {
    expect(await may(client({ row: { enabled: true }, org: { all_modules_comp: false } }))).toBe(
      true,
    );
  });

  it('no row and no comp: off', async () => {
    expect(await may(client({ row: null, org: { all_modules_comp: false } }))).toBe(false);
  });

  it('a COMPED organization has the module with no row at all', async () => {
    expect(await may(client({ row: null, org: { all_modules_comp: true } }))).toBe(true);
  });

  it('the comp wins over an explicit OFF row, which is the ordinary state of a comped organization', async () => {
    expect(await may(client({ row: { enabled: false }, org: { all_modules_comp: true } }))).toBe(
      true,
    );
  });

  it('only an explicit true is a comp: null grants nothing', async () => {
    expect(await may(client({ row: null, org: { all_modules_comp: null } }))).toBe(false);
    expect(await may(client({ row: null, org: null }))).toBe(false);
  });

  it('FAILS CLOSED: an unreadable flag is not a comp', async () => {
    expect(await may(client({ row: null, orgError: { message: 'timeout' } }))).toBe(false);
  });

  it('FAILS CLOSED: an unreadable row is off, and does not take a real comp away either', async () => {
    expect(
      await may(client({ rowError: { message: 'timeout' }, org: { all_modules_comp: false } })),
    ).toBe(false);
    expect(
      await may(client({ rowError: { message: 'timeout' }, org: { all_modules_comp: true } })),
    ).toBe(true);
  });

  it('reads exactly the two tables the rule needs', async () => {
    const c = client({ row: null, org: null });
    await may(c);
    expect(c.asked.sort()).toEqual(['organization_modules', 'organizations']);
  });
});
