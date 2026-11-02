import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reportError } = vi.hoisted(() => ({
  reportError: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import { LOOKUP_ROW_CEILING, reportLookupCeiling } from './lookup-ceiling';

/**
 * B47 read the organization-wide lookups and the warehouse charter links page
 * by page, which removed the 1000-row bound PostgREST had put on each of
 * them. The decisions round (2026-11-01) bounds each such read at one shared
 * ceiling, and reaching it is reported, never silent.
 */
describe('LOOKUP_ROW_CEILING', () => {
  beforeEach(() => reportError.mockClear());

  it('is 10,000 rows: ten pages of 1000, the order catalog bound', () => {
    expect(LOOKUP_ROW_CEILING).toBe(10_000);
  });

  it('a report names the lookup and the organization only, at warning level', () => {
    reportLookupCeiling('categories.list', { organizationId: 'org-1' });

    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0] as unknown as [Error, Record<string, unknown>];
    expect(err.message).toBe('A lookup reached its row ceiling; rows past it are not listed');
    expect(context).toEqual({
      tag: 'lookup_ceiling.categories.list',
      level: 'warning',
      organizationId: 'org-1',
      extra: { lookup: 'categories.list', organizationId: 'org-1' },
    });
  });

  it('a warehouse report names the warehouse and no organization', () => {
    reportLookupCeiling('orders_new.delivery_sites', { warehouseId: 'wh-1' });

    expect(reportError.mock.calls[0]?.[1]).toEqual({
      tag: 'lookup_ceiling.orders_new.delivery_sites',
      level: 'warning',
      organizationId: null,
      extra: { lookup: 'orders_new.delivery_sites', warehouseId: 'wh-1' },
    });
  });
});
