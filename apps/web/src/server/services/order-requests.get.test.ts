import { describe, expect, it } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

/**
 * Service-layer coverage for get() requester-identity resolution.
 *
 * Warehouse print docs (pick slip + both packing slips) and the pick
 * screen render the requester/pickup name from the detail returned here.
 * For the MAJORITY internal self-submit flow the raw `requester_name`
 * column is NULL — the name lives on the joined user_profiles row keyed
 * by `requester_user_id`. get() must resolve name/email with the SAME
 * fallback the list() path uses (free-text column wins, else the joined
 * profile, else null) and expose them as `requesterName`/`requesterEmail`
 * WITHOUT the " · org_label" suffix that `requesterDisplay` carries.
 */

function baseHeader(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ord-1',
    organization_id: 'org-test',
    warehouse_id: 'wh-1',
    status: 'pick_slip_generated',
    requester_user_id: null,
    requester_name: null,
    requester_email: null,
    requester_org_label: null,
    source: 'internal',
    fulfillment_type: 'pickup',
    ...overrides,
  };
}

function getStub(
  header: Record<string, unknown>,
  profile: Record<string, unknown> | null = null,
) {
  return makeSupabaseStub({
    'order_requests.select.maybeSingle': { data: header, error: null },
    'order_request_lines.select': { data: [], error: null },
    'stock_reservations.select': { data: [], error: null },
    'warehouses.select.maybeSingle': { data: { name: 'Main WH' }, error: null },
    'user_profiles.select.maybeSingle': { data: profile, error: null },
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (
    ctx: unknown,
  ) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

describe('OrderRequestsService.get requester resolution', () => {
  it('resolves name/email from user_profiles for an internal self-submit order (raw columns NULL)', async () => {
    const stub = getStub(
      baseHeader({ requester_user_id: 'user-9' }),
      { full_name: 'Jane Doe', email: 'jane@cvsouth.org' },
    );
    const detail = await svc(stub).get('ord-1');
    expect(detail.requesterName).toBe('Jane Doe');
    expect(detail.requesterEmail).toBe('jane@cvsouth.org');
    // requesterDisplay stays the resolved name (no org suffix for internal).
    expect(detail.requesterDisplay).toBe('Jane Doe');
  });

  it('returns the free-text requester_name/email verbatim for an on-behalf-of / public-link order', async () => {
    const stub = getStub(
      baseHeader({
        requester_user_id: null,
        requester_name: 'Doua Vang',
        requester_email: 'doua@example.org',
        requester_org_label: 'Clovis',
      }),
    );
    const detail = await svc(stub).get('ord-1');
    expect(detail.requesterName).toBe('Doua Vang');
    expect(detail.requesterEmail).toBe('doua@example.org');
    // requesterDisplay DOES carry the org suffix — name cells must not.
    expect(detail.requesterDisplay).toBe('Doua Vang · Clovis');
  });

  it('free-text column wins over the profile when both are present', async () => {
    const stub = getStub(
      baseHeader({
        requester_user_id: 'user-9',
        requester_name: 'On Behalf Name',
        requester_email: 'behalf@example.org',
      }),
      { full_name: 'Profile Name', email: 'profile@example.org' },
    );
    const detail = await svc(stub).get('ord-1');
    expect(detail.requesterName).toBe('On Behalf Name');
    expect(detail.requesterEmail).toBe('behalf@example.org');
  });

  it('falls through to the profile per-field (email null on profile stays null)', async () => {
    const stub = getStub(
      baseHeader({ requester_user_id: 'user-9' }),
      { full_name: 'Only Name', email: null },
    );
    const detail = await svc(stub).get('ord-1');
    expect(detail.requesterName).toBe('Only Name');
    expect(detail.requesterEmail).toBeNull();
  });

  it('resolves to null when neither the columns nor a profile carry a value', async () => {
    const stub = getStub(baseHeader({ requester_user_id: null }));
    const detail = await svc(stub).get('ord-1');
    expect(detail.requesterName).toBeNull();
    expect(detail.requesterEmail).toBeNull();
  });
});
