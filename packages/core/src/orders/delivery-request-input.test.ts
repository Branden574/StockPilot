import { describe, expect, it } from 'vitest';

import { ORG_TIMEZONE_DEFAULT } from '../time/org-timezone';

import { DELIVERY_REQUEST_RECIPIENTS } from './delivery-request-recipients';
import {
  buildDeliveryRequestInput,
  type DeliveryRequestOrderData,
} from './delivery-request-input';
import { buildDeliveryRequestDraft, deliveryRequestRecipients } from './delivery-request';
import { resolveRequesterIdentity } from './requester-identity';

const RECIPIENTS = DELIVERY_REQUEST_RECIPIENTS;

function order(over: Partial<DeliveryRequestOrderData> = {}): DeliveryRequestOrderData {
  return {
    id: '9f8e7d6c-5b4a-4321-9876-543210fedcba',
    orderNumber: 80,
    warehouseName: 'Fresno DC4',
    requesterName: 'Jane Smith',
    requesterLabel: 'Jane Smith',
    requesterEmail: 'jane@cvwest.org',
    requesterProfileEmail: null,
    neededBy: '2026-08-20T17:00:00.000Z',
    notes: 'Back gate please.',
    destination: { id: 'ch-1', name: 'CVW Clovis', code: 'CVW-CLO', address: null },
    orgTimezone: 'America/Los_Angeles',
    lines: [{ itemId: 'i1', name: 'Blue Composition Notebook', sku: 'NB-BLUE-01', requested: 24 }],
    ...over,
  };
}

/**
 * The row -> builder-input mapping, which is now the ONLY one. Both surfaces
 * call this: mobile directly, and web is held against it field by field by
 * `apps/web/src/components/orders/delivery-request-parity.test.tsx`.
 *
 * The two fields with real rules are the two that had drifted, so they get the
 * most attention here. Everything else is a pass-through and is asserted as
 * such rather than restated.
 */
describe('buildDeliveryRequestInput', () => {
  it('recipients are a PARAMETER — core never reaches for one tenant mailbox on its own', () => {
    const input = buildDeliveryRequestInput(order(), RECIPIENTS);
    expect(input.recipients).toEqual(RECIPIENTS);

    // A different tenant gets its own routing, with no edit to this module.
    // Through the factory — which is the seam the deferred per-org work uses,
    // and the only way to obtain the branded type.
    const other = buildDeliveryRequestInput(
      order(),
      deliveryRequestRecipients({ to: 'intake@other.example', cc: 'ops@other.example' }),
    );
    expect({ ...other.recipients }).toEqual({ to: 'intake@other.example', cc: 'ops@other.example' });
  });

  it('always declares delivery, so a pickup order can never produce a destination-less delivery draft', () => {
    expect(buildDeliveryRequestInput(order(), RECIPIENTS).fulfillmentType).toBe('delivery');
  });

  // ── DEFECT 2: the org timezone ─────────────────────────────────────────

  it('THE FIX: a missing org timezone resolves to the ONE documented default, not to a second opinion', () => {
    expect(buildDeliveryRequestInput(order({ orgTimezone: null }), RECIPIENTS).orgTimezone).toBe(
      ORG_TIMEZONE_DEFAULT,
    );
    expect(buildDeliveryRequestInput(order({ orgTimezone: '' }), RECIPIENTS).orgTimezone).toBe(
      ORG_TIMEZONE_DEFAULT,
    );
    // And it is emphatically NOT the zone web used to fall back to. This is the
    // assertion that fails if someone reintroduces the divergence from either
    // side.
    expect(buildDeliveryRequestInput(order({ orgTimezone: null }), RECIPIENTS).orgTimezone).not.toBe(
      'UTC',
    );
  });

  it('a STORED zone is passed through untouched, including UTC (the column default) and a non-Pacific one', () => {
    expect(buildDeliveryRequestInput(order({ orgTimezone: 'UTC' }), RECIPIENTS).orgTimezone).toBe(
      'UTC',
    );
    expect(
      buildDeliveryRequestInput(order({ orgTimezone: 'America/New_York' }), RECIPIENTS).orgTimezone,
    ).toBe('America/New_York');
  });

  it('the resolved zone is what the BODY prints and names — the mapping is not cosmetic', () => {
    const input = buildDeliveryRequestInput(
      order({ orgTimezone: null, neededBy: '2026-08-19T01:00:00.000Z' }),
      RECIPIENTS,
    );
    const body = buildDeliveryRequestDraft(input).body;
    expect(body).toContain(`(${ORG_TIMEZONE_DEFAULT})`);
    // 6pm Pacific on the 18th — the same instant a UTC fallback would have
    // dated the 19th, in mail to a warehouse that works Pacific hours.
    expect(body).toContain('Aug 18, 2026');
    expect(body).not.toContain('Aug 19, 2026');
  });

  // ── DEFECT 4: the requester email ──────────────────────────────────────

  it('falls back to the JOINED profile email when the denormalized column is null (internal self-submits)', () => {
    const input = buildDeliveryRequestInput(
      order({ requesterEmail: null, requesterProfileEmail: 'jane@cvwest.org' }),
      RECIPIENTS,
    );
    expect(input.requesterEmail).toBe('jane@cvwest.org');
  });

  it('prefers the denormalized on-behalf-of email over the profile email', () => {
    const input = buildDeliveryRequestInput(
      order({ requesterEmail: 'onbehalf@site.org', requesterProfileEmail: 'staff@cvwest.org' }),
      RECIPIENTS,
    );
    expect(input.requesterEmail).toBe('onbehalf@site.org');
  });

  it('THE FIX: an EMPTY-STRING requester_email is absent, so the profile email is still reachable', () => {
    // Under the old mobile spelling (`??`) the empty string was "present" and
    // won, and the draft builder's truthiness check then dropped it — so the
    // message reached DC4 with no contact at all, while web named one.
    for (const empty of ['', '   ']) {
      const input = buildDeliveryRequestInput(
        order({ requesterEmail: empty, requesterProfileEmail: 'jane@cvwest.org' }),
        RECIPIENTS,
      );
      expect(input.requesterEmail).toBe('jane@cvwest.org');
    }
  });

  it('THE CONSEQUENCE, in the body: an empty column still yields a requester DC4 can reply to', () => {
    const body = buildDeliveryRequestDraft(
      buildDeliveryRequestInput(
        order({ requesterEmail: '', requesterProfileEmail: 'jane@cvwest.org' }),
        RECIPIENTS,
      ),
    ).body;
    expect(body).toContain('Jane Smith (jane@cvwest.org)');
  });

  it('the same rule governs the NAME, which sits one line away and drifted the same way', () => {
    const input = buildDeliveryRequestInput(
      order({ requesterName: '', requesterLabel: 'Jane Smith' }),
      RECIPIENTS,
    );
    expect(input.requestedFor).toBe('Jane Smith');
  });

  it('genuinely absent identity stays absent — never an invented placeholder', () => {
    const input = buildDeliveryRequestInput(
      order({
        warehouseName: null,
        requesterName: null,
        requesterLabel: null,
        requesterEmail: null,
        requesterProfileEmail: null,
        neededBy: null,
        notes: null,
        destination: null,
      }),
      RECIPIENTS,
    );
    expect(input.warehouseName).toBe('');
    expect(input.requestedFor).toBe('');
    expect(input.requesterEmail).toBeNull();
    expect(input.neededByLocal).toBe('');
    expect(input.notes).toBe('');
    expect(input.destination).toBeNull();
    // The builder, not this mapping, owns the honest admission.
    expect(buildDeliveryRequestDraft(input).body).toContain('(requester not recorded)');
  });

  it('both identity fields go through the SHARED resolver, not a local copy of it', () => {
    // Drives the resolver and the mapping over the same matrix and requires
    // they agree — a re-spelled `??` inside the mapping fails here even if the
    // resolver itself is untouched.
    const values = [null, '', '   ', 'column@x.org'] as const;
    const fallbacks = [null, '', 'profile@x.org'] as const;
    for (const column of values) {
      for (const fallback of fallbacks) {
        const input = buildDeliveryRequestInput(
          order({ requesterEmail: column, requesterProfileEmail: fallback }),
          RECIPIENTS,
        );
        expect(input.requesterEmail).toBe(resolveRequesterIdentity(column, fallback));
      }
    }
  });

  // ── Pass-throughs ──────────────────────────────────────────────────────

  it('drops lines with no item id, and the dropped rows do not inflate the counts the body quotes', () => {
    const input = buildDeliveryRequestInput(
      order({
        lines: [
          { itemId: 'i1', name: 'Notebook', sku: 'NB-1', requested: 3 },
          { itemId: null, name: 'orphan', sku: null, requested: 99 },
          { itemId: 'i2', name: 'Pencils', sku: null, requested: 4 },
        ],
      }),
      RECIPIENTS,
    );
    expect(input.lines).toEqual([
      { itemId: 'i1', quantity: 3 },
      { itemId: 'i2', quantity: 4 },
    ]);
    expect(input.itemMap.get('i2')).toEqual({ name: 'Pencils', sku: '' });
    expect(input.itemMap.has('i1')).toBe(true);
    const draft = buildDeliveryRequestDraft(input);
    expect(draft.lineCount).toBe(2);
    expect(draft.unitCount).toBe(7);
  });

  it('the item map carries name and sku ONLY — no staff-only field can ride along', () => {
    const input = buildDeliveryRequestInput(order(), RECIPIENTS);
    expect([...input.itemMap.values()].every((v) => Object.keys(v).length === 2)).toBe(true);
    expect(input.itemMap.get('i1')).toEqual({ name: 'Blue Composition Notebook', sku: 'NB-BLUE-01' });
  });
});
