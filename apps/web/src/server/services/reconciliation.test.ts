import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { ReconciliationService } from './reconciliation';

/**
 * The reconciliation numbers are purchase order totals, read through the
 * caller's own purchase order access (the views are security_invoker). Since
 * migration 0423 a member without purchase_orders:read reads no purchase
 * order at all, so a direct call is refused in the permission's words instead
 * of answering zeros; the page shows the purchase order access message first.
 */
describe('ReconciliationService.summary', () => {
  it('refuses without purchase_orders:read, before any read', async () => {
    const stub = makeSupabaseStub({});
    const svc = new ReconciliationService(
      makeServiceContext(stub.client, {
        role: 'admin',
        permissions: new Set(['organization:update']),
      }) as never,
    );

    const err = await svc.summary().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toBe('Missing permission: purchase_orders:read');
    expect(stub.fromCalls).toEqual([]);
  });

  it('answers an owner or admin who must enroll in MFA but has not yet: a read, so no step-up gate', async () => {
    // Under the admins_required policy the dashboard lets an unenrolled owner
    // or admin in with a banner, and the page's own check (can()) has no MFA
    // step. assertPermission's MFA gate made this read throw mfa_required into
    // the error boundary; the permission alone decides it, as on the page.
    const stub = makeSupabaseStub({
      'vw_po_reconciliation.select': { data: [], error: null },
      'vw_vendor_performance.select': { data: [], error: null },
      'vw_warehouse_inbound.select': { data: [], error: null },
    });
    const svc = new ReconciliationService(
      makeServiceContext(stub.client, {
        role: 'admin',
        permissions: new Set(['organization:update', 'purchase_orders:read']),
        mfaRequired: true,
        mfaSatisfied: false,
      }) as never,
    );

    const res = await svc.summary();

    expect(res.totals.qtyOrdered).toBe(0);
    expect(stub.fromCalls).toEqual([
      'vw_po_reconciliation',
      'vw_vendor_performance',
      'vw_warehouse_inbound',
    ]);
  });

  it('reads the three views for a caller who holds it', async () => {
    const stub = makeSupabaseStub({
      'vw_po_reconciliation.select': { data: [], error: null },
      'vw_vendor_performance.select': { data: [], error: null },
      'vw_warehouse_inbound.select': { data: [], error: null },
    });
    const svc = new ReconciliationService(
      makeServiceContext(stub.client, {
        role: 'admin',
        permissions: new Set(['organization:update', 'purchase_orders:read']),
      }) as never,
    );

    const res = await svc.summary();

    expect(res.totals.qtyOrdered).toBe(0);
    expect(stub.fromCalls).toEqual([
      'vw_po_reconciliation',
      'vw_vendor_performance',
      'vw_warehouse_inbound',
    ]);
  });
});
