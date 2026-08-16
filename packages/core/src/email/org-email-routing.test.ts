import { describe, expect, it } from 'vitest';

import {
  ORG_EMAIL_ROUTING_FEATURES,
  parseOrgEmailRouting,
  brandDeliveryRecipients,
  brandMaintenanceRecipients,
  type OrgEmailRoutingReadState,
} from './org-email-routing';
import {
  DELIVERY_REQUEST_EMAIL,
  deliveryRecipientsForRouting,
  deliveryRequestCcNotice,
  DELIVERY_REQUEST_CC_NOTICE,
} from '../orders/delivery-request-recipients';
import {
  L4L_MAINTENANCE_EMAIL,
  maintenanceRecipientsForRouting,
} from '../maintenance/constants';

/** A stored value in the exact shape migration 0337 seeds. */
const VALID_ROW = {
  delivery_request: {
    to: 'warehouse-demo@stockpilot-demo.invalid',
    cc: 'manager-demo@stockpilot-demo.invalid',
    toName: 'Demo Warehouse Intake',
    ccName: 'Demo Warehouse Manager',
  },
  maintenance_request: {
    to: 'facilities-demo@stockpilot-demo.invalid',
    cc: 'manager-demo@stockpilot-demo.invalid',
  },
};

describe('parseOrgEmailRouting — the fallback-matrix states', () => {
  it('exports exactly the two feature keys', () => {
    expect([...ORG_EMAIL_ROUTING_FEATURES]).toEqual(['delivery_request', 'maintenance_request']);
  });

  it('UNSET: a NULL column hides the action for both features', () => {
    expect(parseOrgEmailRouting(null, 'delivery_request')).toEqual({ state: 'unset' });
    expect(parseOrgEmailRouting(undefined, 'maintenance_request')).toEqual({ state: 'unset' });
  });

  it('UNSET: an absent feature key hides only that feature', () => {
    const row = { delivery_request: VALID_ROW.delivery_request };
    expect(parseOrgEmailRouting(row, 'maintenance_request')).toEqual({ state: 'unset' });
    expect(parseOrgEmailRouting(row, 'delivery_request').state).toBe('valid');
  });

  it('VALID: a stored value round-trips through the branded factory as plain strings', () => {
    const parsed = parseOrgEmailRouting(VALID_ROW, 'delivery_request');
    expect(parsed).toEqual({
      state: 'valid',
      recipients: {
        to: 'warehouse-demo@stockpilot-demo.invalid',
        cc: 'manager-demo@stockpilot-demo.invalid',
        toName: 'Demo Warehouse Intake',
        ccName: 'Demo Warehouse Manager',
      },
    });
    // Name-less entries omit the keys rather than carrying undefined.
    const maint = parseOrgEmailRouting(VALID_ROW, 'maintenance_request');
    if (maint.state !== 'valid') throw new Error('expected valid');
    expect(Object.keys(maint.recipients).sort()).toEqual(['cc', 'to']);
  });

  it('INVALID: a malformed address fails CLOSED with the guard message verbatim', () => {
    const parsed = parseOrgEmailRouting(
      { delivery_request: { to: 'a?cc=attacker@evil.test', cc: 'copy@ok.invalid' } },
      'delivery_request',
    );
    expect(parsed.state).toBe('invalid');
    if (parsed.state !== 'invalid') throw new Error('expected invalid');
    expect(parsed.reason).toMatch(/recipient "to" must be exactly one plain email address/);
  });

  it('INVALID: an unsafe display name fails CLOSED (silent-CC-drop class)', () => {
    const parsed = parseOrgEmailRouting(
      {
        maintenance_request: {
          to: 'intake@ok.invalid',
          cc: 'copy@ok.invalid',
          ccName: 'Ops, Manager',
        },
      },
      'maintenance_request',
    );
    expect(parsed.state).toBe('invalid');
    if (parsed.state !== 'invalid') throw new Error('expected invalid');
    expect(parsed.reason).toMatch(/RFC 5322 specials/);
  });

  it('INVALID: wrong shapes — non-object column, non-object entry, non-string fields', () => {
    expect(parseOrgEmailRouting('a string', 'delivery_request').state).toBe('invalid');
    expect(parseOrgEmailRouting([], 'delivery_request').state).toBe('invalid');
    expect(parseOrgEmailRouting({ delivery_request: 'x' }, 'delivery_request').state).toBe(
      'invalid',
    );
    expect(
      parseOrgEmailRouting({ delivery_request: { to: 1, cc: 'a@b.invalid' } }, 'delivery_request')
        .state,
    ).toBe('invalid');
    expect(
      parseOrgEmailRouting(
        { delivery_request: { to: 'a@b.invalid', cc: 'c@d.invalid', toName: 5 } },
        'delivery_request',
      ).state,
    ).toBe('invalid');
    // A missing cc is the acceptance-gate loss this whole feature guards.
    expect(
      parseOrgEmailRouting({ delivery_request: { to: 'a@b.invalid' } }, 'delivery_request').state,
    ).toBe('invalid');
  });

  it('features parse independently — one invalid key does not poison the other', () => {
    const row = {
      delivery_request: VALID_ROW.delivery_request,
      maintenance_request: { to: 'broken', cc: 'copy@ok.invalid' },
    };
    expect(parseOrgEmailRouting(row, 'delivery_request').state).toBe('valid');
    expect(parseOrgEmailRouting(row, 'maintenance_request').state).toBe('invalid');
  });
});

describe('recipientsForRouting — what a surface may compose with, per state', () => {
  const VALID: OrgEmailRoutingReadState = {
    state: 'valid',
    recipients: { to: 'intake@other-tenant.invalid', cc: 'copy@other-tenant.invalid' },
  };

  it("FALLBACK (column missing, 42703): the compiled constants — today's behavior, deploy window only", () => {
    const d = deliveryRecipientsForRouting({ state: 'fallback' });
    expect(d?.to).toBe(DELIVERY_REQUEST_EMAIL.to);
    expect(d?.cc).toBe(DELIVERY_REQUEST_EMAIL.cc);
    const m = maintenanceRecipientsForRouting({ state: 'fallback' });
    expect(m?.to).toBe(L4L_MAINTENANCE_EMAIL.to);
    expect(m?.cc).toBe(L4L_MAINTENANCE_EMAIL.cc);
  });

  it('VALID: the stored recipients, branded — never the constants', () => {
    const d = deliveryRecipientsForRouting(VALID);
    expect(d?.to).toBe('intake@other-tenant.invalid');
    expect(d?.cc).toBe('copy@other-tenant.invalid');
    const m = maintenanceRecipientsForRouting(VALID);
    expect(m?.cc).toBe('copy@other-tenant.invalid');
  });

  it('MUTATION KILL: UNSET yields null for BOTH features — an unconfigured org never gets L4L mailboxes', () => {
    // The mutant under test is `case 'unset': return <compiled constants>`,
    // which would wire every unconfigured org to one tenant's real intake —
    // the exact multi-tenant leak this feature exists to end.
    expect(deliveryRecipientsForRouting({ state: 'unset' })).toBeNull();
    expect(maintenanceRecipientsForRouting({ state: 'unset' })).toBeNull();
  });

  it('MUTATION KILL: INVALID yields null — never a silent fallback to another tenant', () => {
    const invalid: OrgEmailRoutingReadState = { state: 'invalid', reason: 'x' };
    expect(deliveryRecipientsForRouting(invalid)).toBeNull();
    expect(maintenanceRecipientsForRouting(invalid)).toBeNull();
  });

  it('belt-and-braces: a hand-built "valid" carrying a malformed cc fails CLOSED, not open', () => {
    const poisoned: OrgEmailRoutingReadState = {
      state: 'valid',
      recipients: { to: 'intake@ok.invalid', cc: 'a?cc=attacker@evil.test' },
    };
    expect(deliveryRecipientsForRouting(poisoned)).toBeNull();
    expect(maintenanceRecipientsForRouting(poisoned)).toBeNull();
  });
});

describe('brand helpers and the notice', () => {
  it('brandDeliveryRecipients / brandMaintenanceRecipients throw the factory guards', () => {
    expect(() => brandDeliveryRecipients({ to: 'nope', cc: 'copy@ok.invalid' })).toThrow(
      /plain email address/,
    );
    expect(() => brandMaintenanceRecipients({ to: 'intake@ok.invalid', cc: '' })).toThrow(
      /plain email address/,
    );
    expect(brandDeliveryRecipients({ to: 'a@b.invalid', cc: 'c@d.invalid' }).to).toBe('a@b.invalid');
  });

  it('the delivery notice is a pure function of the recipients, and the compiled constant is the function applied to the compiled pair', () => {
    expect(deliveryRequestCcNotice({ to: 'a@b.invalid', cc: 'c@d.invalid' })).toBe(
      'This request will be emailed to a@b.invalid. A copy will also be sent to c@d.invalid.',
    );
    expect(DELIVERY_REQUEST_CC_NOTICE).toBe(deliveryRequestCcNotice(DELIVERY_REQUEST_EMAIL));
  });
});
