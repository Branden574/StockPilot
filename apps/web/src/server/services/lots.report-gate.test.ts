import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { LotsService } from './lots';

/**
 * Security invariant (2026-09-28): the two lot REPORTS (Aging & expiry,
 * Recall / lot trace) check reports:read on their data path, not only in the
 * reports layout. traceLot is reached through a server action, which is
 * callable without the page; it used to check the lot module alone. The
 * aging scan behind picking's FEFO suggestions stays open to pickers.
 */

const withLotSerial = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'lot_serial']);
const noReports = { role: 'staff' as const, permissions: new Set(['items:read']), enabledModules: withLotSerial() };

function emptyStub() {
  return makeSupabaseStub({
    'receipt_line_lots.select': { data: [], error: null },
    'lot_pick_events.select': { data: [], error: null },
  });
}

describe('LotsService report gate', () => {
  it('traceLot refuses a member without reports:read, before any read', async () => {
    const stub = emptyStub();
    const svc = new LotsService(makeServiceContext(stub.client, noReports));
    await expect(svc.traceLot('LOT-1')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Missing permission: reports:read',
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('agingReport refuses a member without reports:read, before any read', async () => {
    const stub = emptyStub();
    const svc = new LotsService(makeServiceContext(stub.client, noReports));
    await expect(svc.agingReport()).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.fromCalls).toEqual([]);
  });

  it('both run the MFA step-up first', async () => {
    const stub = emptyStub();
    const svc = new LotsService({
      ...makeServiceContext(stub.client, {
        role: 'owner',
        mfaRequired: true,
        mfaSatisfied: false,
        enabledModules: withLotSerial(),
      }),
      mfaEnrolled: true,
    });
    await expect(svc.traceLot('LOT-1')).rejects.toMatchObject({ details: { reason: 'aal2_required' } });
    await expect(svc.agingReport()).rejects.toMatchObject({ details: { reason: 'aal2_required' } });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a reports:read holder gets the report', async () => {
    const stub = emptyStub();
    const svc = new LotsService(
      makeServiceContext(stub.client, { role: 'staff', enabledModules: withLotSerial() }),
    );
    await expect(svc.agingReport()).resolves.toEqual([]);
    await expect(svc.traceLot('LOT-1')).resolves.toMatchObject({ receipts: [], picks: [] });
  });

  it('picking\'s FEFO suggestions (the aging scan) stay open without reports:read', async () => {
    const stub = emptyStub();
    const svc = new LotsService(makeServiceContext(stub.client, noReports));
    await expect(svc.getAgingInventory()).resolves.toEqual([]);
    await expect(svc.getFefoSuggestion('item-1')).resolves.toEqual([]);
  });
});
