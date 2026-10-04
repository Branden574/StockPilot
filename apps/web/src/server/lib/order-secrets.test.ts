import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Permission } from '@stockpilot/core';

import { sha256Hex } from '@/lib/token-hash';
import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import {
  handOverLinkWanted,
  handOverMfaBlock,
  handOverMfaPanelMessage,
  handOverAllowed,
  hasCapturedSignature,
  isHandOverEntitled,
  LINK_SIGN_LIMIT_PER_HOUR,
  mayHandOverOrder,
  MEMBER_SIGN_LIMIT_PER_HOUR,
  orderIdForReturnToken,
  readOrderSecrets,
  resolveReturnToken,
  resolveSignatureToken,
  resolveTrackToken,
  sideTokenIsLive,
  signatureLinkToken,
} from './order-secrets';

/**
 * Migrations 0389 and 0392 (slices B and C, order secrets). The raw signature
 * token lives in order_request_secrets (service-only); the order column every
 * member reads holds its sha256 as 64 lowercase hex: every mint since 0389,
 * and every older token since 0392 hashed it in place (copying the live ones
 * to the side table first). The return and track tokens live only in the
 * side table since 0392. These helpers are the one place that rule lives (the
 * sign route, the sign page, the warehouse slip, the order page, the tracker,
 * the return portal and the scan lookup all call them), and since 0392 none
 * of them reads or trusts an order column as a raw token.
 */

const RAW = 'a1'.repeat(32);
const DIGEST = sha256Hex(RAW);
const LEGACY = 'b2'.repeat(32);
const ORDER = '0a000000-0000-4000-8000-000000000389';
const ORG = 'org-389';

describe('sha256Hex agrees with Postgres', () => {
  it("pins the 'abc' vector the pgTAP suite pins for encode(extensions.digest('abc','sha256'),'hex')", () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(RAW)).toBe(createHash('sha256').update(RAW).digest('hex'));
    expect(DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sideTokenIsLive', () => {
  it('is true only for the preimage of the column', () => {
    expect(sideTokenIsLive(RAW, DIGEST)).toBe(true);
    expect(sideTokenIsLive(RAW, LEGACY)).toBe(false);
    expect(sideTokenIsLive(null, DIGEST)).toBe(false);
    expect(sideTokenIsLive(RAW, null)).toBe(false);
    // The digest itself is not its own preimage.
    expect(sideTokenIsLive(DIGEST, DIGEST)).toBe(false);
  });
});

function secretsStub(side: Record<string, unknown> | null, opts: { sideError?: boolean } = {}) {
  return makeSupabaseStub({
    'order_request_secrets.select': opts.sideError
      ? { data: null, error: { message: 'connection reset' } }
      : servedLikePostgrest(side ? [{ order_request_id: ORDER, ...side }] : []),
  });
}

describe('readOrderSecrets', () => {
  it('reads the side row by order id, and tells a failed read from no row', async () => {
    const s = secretsStub({
      signature_token: RAW,
      return_token: 'r-1',
      public_track_token: 'c'.repeat(64),
      signature_data_url: null,
    });
    expect(await readOrderSecrets(s.client, ORDER)).toEqual({
      ok: true,
      secrets: {
        signatureToken: RAW,
        returnToken: 'r-1',
        publicTrackToken: 'c'.repeat(64),
        signatureDataUrl: null,
      },
    });
    expect(s.chainArgs.get('order_request_secrets.select')).toContainEqual(['order_request_id', ORDER]);
    expect(await readOrderSecrets(secretsStub(null).client, ORDER)).toEqual({ ok: true, secrets: null });
    expect(await readOrderSecrets(secretsStub(null, { sideError: true }).client, ORDER)).toEqual({ ok: false });
  });
});

describe('signatureLinkToken (the raw token for a link or a QR)', () => {
  it('the side token when its digest is the column', async () => {
    expect(await signatureLinkToken(secretsStub({ signature_token: RAW }).client, ORDER, DIGEST)).toBe(RAW);
  });

  it('0392: never the column when no side token hashes to it (no side row, or a stale side token): the column is a digest, so nothing goes in the link', async () => {
    expect(await signatureLinkToken(secretsStub(null).client, ORDER, LEGACY)).toBeNull();
    expect(await signatureLinkToken(secretsStub({ signature_token: RAW }).client, ORDER, LEGACY)).toBeNull();
    expect(await signatureLinkToken(secretsStub({ signature_token: null }).client, ORDER, DIGEST)).toBeNull();
  });

  it('nothing when the column is empty (cleared by reopen or resume, a stale side token is ignored), without a read', async () => {
    const s = secretsStub({ signature_token: RAW });
    expect(await signatureLinkToken(s.client, ORDER, null)).toBeNull();
    expect(s.fromCalls).toEqual([]);
  });

  it('nothing when the side table cannot be read: a digest is never put in a link', async () => {
    expect(await signatureLinkToken(secretsStub(null, { sideError: true }).client, ORDER, DIGEST)).toBeNull();
  });
});

function signStub(opts: {
  column: string | null;
  side?: string | null;
  sideError?: boolean;
  orderError?: boolean;
}) {
  const order = { id: ORDER, organization_id: ORG, signature_token: opts.column };
  return makeSupabaseStub({
    'order_requests.select': opts.orderError
      ? { data: null, error: { message: 'boom' } }
      : servedLikePostgrest([order]),
    'order_request_secrets.select': opts.sideError
      ? { data: null, error: { message: 'connection reset' } }
      : servedLikePostgrest(
          opts.side === undefined ? [] : [{ order_request_id: ORDER, signature_token: opts.side }],
        ),
  });
}

describe('resolveSignatureToken (how a presented token reaches its order)', () => {
  it('link: the raw token of a 0389 mint (its sha256 is the column); the digest is what the frozen RPC compares', async () => {
    const s = signStub({ column: DIGEST, side: RAW });
    const m = await resolveSignatureToken<{ id: string }>(s.client, RAW, 'id, organization_id');
    expect(m).toMatchObject({ via: 'link', columnToken: DIGEST });
    expect(m?.order.id).toBe(ORDER);
    // Looked up by the hash, first.
    expect(s.chainArgsAll.get('order_requests.select')?.[0]).toContainEqual(['signature_token', DIGEST]);
  });

  it('member: the DIGEST itself (every member reads it) matches the column and a side token hashes to it', async () => {
    const m = await resolveSignatureToken(signStub({ column: DIGEST, side: RAW }).client, DIGEST, 'id');
    expect(m).toMatchObject({ via: 'member', columnToken: DIGEST });
  });

  it('0392: a value equal to the column is ALWAYS member (a digest), whatever the side table holds: no session-free legacy link is left', async () => {
    for (const side of [undefined, RAW, null] as const) {
      expect(
        await resolveSignatureToken(signStub({ column: LEGACY, side }).client, LEGACY, 'id'),
        String(side),
      ).toMatchObject({ via: 'member', columnToken: LEGACY });
    }
    expect(
      await resolveSignatureToken(signStub({ column: LEGACY, sideError: true }).client, LEGACY, 'id'),
    ).toMatchObject({ via: 'member' });
  });

  it('0392: resolving never reads the side table (the column decides: a digest of the presented value is a link, the value itself a member)', async () => {
    const s = signStub({ column: DIGEST, side: RAW });
    await resolveSignatureToken(s.client, RAW, 'id');
    await resolveSignatureToken(s.client, DIGEST, 'id');
    expect(s.fromCalls).not.toContain('order_request_secrets');
  });

  it('a raw token minted before 0389 and hashed in place by 0392 is a link, like any QR', async () => {
    const hashedLegacy = sha256Hex(LEGACY);
    expect(await resolveSignatureToken(signStub({ column: hashedLegacy }).client, LEGACY, 'id')).toMatchObject({
      via: 'link',
      columnToken: hashedLegacy,
    });
  });

  it('no match: an unknown token, a cleared column, a malformed token or a failed lookup', async () => {
    expect(await resolveSignatureToken(signStub({ column: DIGEST, side: RAW }).client, 'c'.repeat(64), 'id')).toBeNull();
    expect(await resolveSignatureToken(signStub({ column: null, side: RAW }).client, RAW, 'id')).toBeNull();
    expect(await resolveSignatureToken(signStub({ column: DIGEST }).client, 'not-hex', 'id')).toBeNull();
    expect(await resolveSignatureToken(signStub({ column: DIGEST, orderError: true }).client, RAW, 'id')).toBeNull();
  });
});

describe('return and track tokens: the side table only (0392 moved every column value there)', () => {
  it('resolveReturnToken / resolveTrackToken read the side row, and nothing else', async () => {
    const side = secretsStub({ return_token: 'side-r', public_track_token: 'side-t' });
    expect(await resolveReturnToken(side.client, ORDER)).toBe('side-r');
    expect(await resolveTrackToken(side.client, ORDER)).toBe('side-t');
    expect(side.fromCalls.every((t) => t === 'order_request_secrets')).toBe(true);
    const none = secretsStub(null);
    expect(await resolveReturnToken(none.client, ORDER)).toBeNull();
    expect(await resolveTrackToken(none.client, ORDER)).toBeNull();
  });

  it('a failed side read is no token (the link is left out), never a column value', async () => {
    const failed = secretsStub(null, { sideError: true });
    expect(await resolveReturnToken(failed.client, ORDER)).toBeNull();
    expect(await resolveTrackToken(failed.client, ORDER)).toBeNull();
    expect(failed.fromCalls).not.toContain('order_requests');
  });

  it('orderIdForReturnToken: a side token opens its order; an order column value opens nothing (0392)', async () => {
    const stub = (sideRows: unknown[], orderRows: unknown[]) =>
      makeSupabaseStub({
        'order_request_secrets.select': servedLikePostgrest(sideRows as Record<string, unknown>[]),
        'order_requests.select': servedLikePostgrest(orderRows as Record<string, unknown>[]),
      });
    const TOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await orderIdForReturnToken(stub([{ order_request_id: ORDER, return_token: TOK }], []).client, TOK)).toBe(ORDER);
    const columnOnly = stub([], [{ id: 'legacy-order', return_token: TOK }]);
    expect(await orderIdForReturnToken(columnOnly.client, TOK)).toBeNull();
    expect(columnOnly.fromCalls).not.toContain('order_requests');
    expect(await orderIdForReturnToken(stub([{ order_request_id: 'other', return_token: 'x' }], []).client, TOK)).toBeNull();
    const failed = makeSupabaseStub({
      'order_request_secrets.select': { data: null, error: { message: 'down' } },
      'order_requests.select': servedLikePostgrest([{ id: 'legacy-order', return_token: TOK }]),
    });
    expect(await orderIdForReturnToken(failed.client, TOK)).toBeNull();
  });
});

describe('isHandOverEntitled (who may collect a signature or print its QR)', () => {
  const order = (driver: string | null) => ({ assigned_delivery_user_id: driver });
  it('effective orders:approve, or the assigned driver; nobody else', () => {
    // Static role defaults (no effective set): manager, admin and owner hold orders:approve.
    expect(isHandOverEntitled({ userId: 'u', role: 'manager' }, order(null))).toBe(true);
    expect(isHandOverEntitled({ userId: 'u', role: 'owner' }, order(null))).toBe(true);
    expect(isHandOverEntitled({ userId: 'u', role: 'staff' }, order(null))).toBe(false);
    expect(isHandOverEntitled({ userId: 'u', role: 'viewer' }, order(null))).toBe(false);
    // An override that grants it to staff counts; one that revokes it from a manager counts too (K9c).
    expect(
      isHandOverEntitled({ userId: 'u', role: 'staff', permissions: new Set(['orders:approve']) }, order(null)),
    ).toBe(true);
    expect(
      isHandOverEntitled({ userId: 'u', role: 'manager', permissions: new Set(['orders:request']) }, order(null)),
    ).toBe(false);
    // The assigned driver, whatever their role.
    expect(isHandOverEntitled({ userId: 'drv', role: 'staff' }, order('drv'))).toBe(true);
    expect(isHandOverEntitled({ userId: 'drv', role: 'viewer' }, order('someone-else'))).toBe(false);
  });

  it('the member path allows 60 hand-overs an hour per member (R4)', () => {
    expect(MEMBER_SIGN_LIMIT_PER_HOUR).toBe(60);
  });

  it('a link allows 10 attempts an hour per token (F3: never counted on the member path)', () => {
    expect(LINK_SIGN_LIMIT_PER_HOUR).toBe(10);
  });
});

describe("handOverAllowed / mayHandOverOrder: the hand-over also needs the mint's warehouse rule (review finding 1)", () => {
  // generate_order_packing_slips refuses an approver without write access to
  // the order's warehouse (user_can_access_inventory 'write': manager rank
  // always, else an assignment and not a viewer). The surfaces that hand the
  // order over (the sign route's member path, the warehouse slip's QR, the
  // order page's link) follow the same rule for everyone but the assigned
  // driver, who was put on the order by a manager.
  const order = (driver: string | null, warehouse: string | null = 'wh-1') => ({
    assigned_delivery_user_id: driver,
    warehouse_id: warehouse,
  });
  const staffApprover = { userId: 'stf', role: 'staff' as const, permissions: new Set<Permission>(['orders:approve']) };
  const access = (writableIds: string[], hasAllAccess = false) => ({ hasAllAccess, writableIds });

  it('manager rank needs no warehouse read (the role decides, as in user_can_access_inventory)', () => {
    expect(handOverAllowed({ userId: 'm', role: 'manager' }, order(null), null)).toBe(true);
    expect(handOverAllowed({ userId: 'o', role: 'owner' }, order(null, null), null)).toBe(true);
  });

  it('a staff approver only for an order in a warehouse they may write to', () => {
    expect(handOverAllowed(staffApprover, order(null), access(['wh-1']))).toBe(true);
    expect(handOverAllowed(staffApprover, order(null), access(['wh-2']))).toBe(false);
    expect(handOverAllowed(staffApprover, order(null), access([], true))).toBe(true);
    // An access read that failed (null) or an order with no warehouse is no access.
    expect(handOverAllowed(staffApprover, order(null), null)).toBe(false);
    expect(handOverAllowed(staffApprover, order(null, null), access(['wh-1']))).toBe(false);
  });

  it('never a viewer as an approver (a write), whatever an override grants', () => {
    expect(
      handOverAllowed({ userId: 'v', role: 'viewer', permissions: new Set(['orders:approve']) }, order(null), access([], true)),
    ).toBe(false);
  });

  it('the assigned driver, with no warehouse rule; nobody without orders:approve otherwise', () => {
    expect(handOverAllowed({ userId: 'drv', role: 'staff' }, order('drv'), null)).toBe(true);
    expect(handOverAllowed({ userId: 'stf', role: 'staff' }, order('drv'), access(['wh-1']))).toBe(false);
    expect(
      handOverAllowed({ userId: 'm', role: 'manager', permissions: new Set(['orders:request']) }, order(null), null),
    ).toBe(false);
  });

  it('mayHandOverOrder reads the warehouse access only for an approver whose role does not decide it', async () => {
    const assignments = (rows: Array<{ warehouse_id: string; is_primary: boolean }>) =>
      makeSupabaseStub({
        'user_warehouse_assignments.select': { data: rows, error: null },
        'organization_members.select': { data: { all_warehouses: false }, error: null },
      });
    const ctx = (supabase: unknown, over: Record<string, unknown>) =>
      ({ organizationId: ORG, userId: 'stf', role: 'staff', supabase, ...over }) as never;

    const assigned = assignments([{ warehouse_id: 'wh-1', is_primary: true }]);
    expect(await mayHandOverOrder(ctx(assigned.client, { permissions: new Set(['orders:approve']) }), order(null))).toBe(true);
    const elsewhere = assignments([{ warehouse_id: 'wh-2', is_primary: true }]);
    expect(await mayHandOverOrder(ctx(elsewhere.client, { permissions: new Set(['orders:approve']) }), order(null))).toBe(false);
    const failed = makeSupabaseStub({
      'user_warehouse_assignments.select': { data: null, error: { message: 'down' } },
      'organization_members.select': { data: { all_warehouses: false }, error: null },
    });
    expect(await mayHandOverOrder(ctx(failed.client, { permissions: new Set(['orders:approve']) }), order(null))).toBe(false);
    // A read that throws (getWarehouseAccess then rejects) is no access either.
    const throwing = {
      from: () => {
        throw new Error('socket hang up');
      },
    };
    expect(await mayHandOverOrder(ctx(throwing, { permissions: new Set(['orders:approve']) }), order(null))).toBe(false);

    const none = makeSupabaseStub();
    expect(await mayHandOverOrder(ctx(none.client, { role: 'manager', userId: 'm' }), order(null))).toBe(true);
    expect(await mayHandOverOrder(ctx(none.client, { userId: 'drv' }), order('drv'))).toBe(true);
    expect(await mayHandOverOrder(ctx(none.client, {}), order(null))).toBe(false);
    expect(none.fromCalls).toEqual([]);
  });
});

describe('handOverMfaBlock (F2): the MFA rule assertPermission applies, for the raw hand-over link', () => {
  it('nothing in the way when MFA is not required, or is satisfied', () => {
    expect(handOverMfaBlock({ mfaRequired: false, mfaSatisfied: true })).toBeNull();
    expect(handOverMfaBlock({ mfaRequired: false, mfaSatisfied: false })).toBeNull();
    expect(handOverMfaBlock({ mfaRequired: true, mfaSatisfied: true, mfaEnrolled: true })).toBeNull();
  });

  it('an enrolled member at AAL1 must step up (aal2_required), in the shared gate words', () => {
    expect(handOverMfaBlock({ mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true })).toEqual({
      reason: 'aal2_required',
      message: 'Re-authenticate with MFA before performing this action.',
    });
  });

  it('a member bound by a policy who has not enrolled must enroll (mfa_required)', () => {
    expect(handOverMfaBlock({ mfaRequired: true, mfaSatisfied: false, mfaEnrolled: false })?.reason).toBe('mfa_required');
    expect(handOverMfaBlock({ mfaRequired: true, mfaSatisfied: false })?.reason).toBe('mfa_required');
  });

  it("the panel's words say what to do to collect a signature", () => {
    expect(handOverMfaPanelMessage('aal2_required')).toBe('Re-authenticate with MFA to collect a signature.');
    expect(handOverMfaPanelMessage('mfa_required')).toBe(
      'Set up multi-factor authentication in Settings to collect a signature.',
    );
  });
});

describe('the order page panel props', () => {
  const base = {
    showActionsPanel: true,
    viewerMayHandOver: true,
    mfaBlocked: false,
    status: 'staged_for_pickup',
    signatureTokenColumn: DIGEST,
  };
  it('a link only at staged for pickup or in transit, only for someone who may hand it over, only when minted', () => {
    expect(handOverLinkWanted(base)).toBe(true);
    expect(handOverLinkWanted({ ...base, status: 'in_transit' })).toBe(true);
    for (const status of ['packing_slip_generated', 'staged_for_delivery', 'completed', 'picking_in_progress']) {
      expect(handOverLinkWanted({ ...base, status }), status).toBe(false);
    }
    expect(handOverLinkWanted({ ...base, viewerMayHandOver: false })).toBe(false);
    expect(handOverLinkWanted({ ...base, showActionsPanel: false })).toBe(false);
    expect(handOverLinkWanted({ ...base, signatureTokenColumn: null })).toBe(false);
  });

  it('F2: no link while the viewer owes an MFA step-up (the link hands over with no session)', () => {
    expect(handOverLinkWanted({ ...base, mfaBlocked: true })).toBe(false);
    expect(handOverLinkWanted({ ...base, status: 'in_transit', mfaBlocked: true })).toBe(false);
  });

  it('View signature shows for a digital hand-over even once the image leaves the row (slice C); never for paper', () => {
    expect(hasCapturedSignature({ signature_method: 'digital', signature_data_url: null })).toBe(true);
    expect(hasCapturedSignature({ signature_method: null, signature_data_url: 'data:image/png;base64,AA' })).toBe(true);
    expect(hasCapturedSignature({ signature_method: 'physical', signature_data_url: null })).toBe(false);
    expect(hasCapturedSignature({ signature_method: null, signature_data_url: null })).toBe(false);
  });
});
