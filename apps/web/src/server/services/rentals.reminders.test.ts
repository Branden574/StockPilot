import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RentalsService.overdueRemindersOn: whether the daily sweep sends overdue
 * reminders for the caller's organization, as the rental pages show it.
 *
 * It must read what cron/rental-overdue reads (the explicit organization_modules
 * row for rentals, enabled) and never the comp; a comped organization with
 * the row off gets no reminder, and its pages must not promise one. A failed
 * read is null ("could not check"), never true or false.
 */

vi.mock('@/lib/auth/warehouse', () => ({
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/email/rentals', () => ({
  sendRentalCheckoutEmail: vi.fn(async () => undefined),
  sendRentalReturnedEmail: vi.fn(async () => undefined),
}));

import { callArgs, makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { RentalsService } from './rentals';

function svc(row: { data: unknown; error: { message: string } | null }) {
  const stub = makeSupabaseStub({ 'organization_modules.select.maybeSingle': row });
  return { stub, service: new RentalsService(makeServiceContext(stub.client)) };
}

beforeEach(() => vi.clearAllMocks());

describe('RentalsService.overdueRemindersOn', () => {
  it('reads the explicit rentals row for this organization with the caller client', async () => {
    const { stub, service } = svc({ data: { enabled: true }, error: null });
    await expect(service.overdueRemindersOn()).resolves.toBe(true);
    const methods = stub.chainsAll.get('organization_modules.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('organization_modules.select')?.[0] ?? [];
    const read: MockCall = { table: 'organization_modules', op: 'select', methods, args };
    expect(callArgs(read, 'select')).toEqual(['enabled']);
    expect(args.filter((_, i) => methods[i] === 'eq')).toEqual([
      ['organization_id', 'org-test'],
      ['module_id', 'rentals'],
    ]);
    // Never the comp: the organization row is not read at all.
    expect(stub.fromCalls).toEqual(['organization_modules']);
  });

  it('a row that is off, or no row at all (a comped organization), is off', async () => {
    await expect(svc({ data: { enabled: false }, error: null }).service.overdueRemindersOn()).resolves.toBe(false);
    await expect(svc({ data: null, error: null }).service.overdueRemindersOn()).resolves.toBe(false);
  });

  it('a failed read is null, never a guess', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      svc({ data: null, error: { message: 'connection reset' } }).service.overdueRemindersOn(),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
