import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

import type { OrderRequestRow } from '@/server/services/order-requests';

/**
 * sendOrderRequestEmail is the single choke point for every
 * order-request email. This suite pins the public-recipient opt-out
 * contract (migration 0222):
 *   - lifecycle emails to an unsubscribed anonymous recipient are
 *     SKIPPED,
 *   - the confirm_request double-opt-in email is exempt (suppressing it
 *     would silently brick a request the recipient just submitted),
 *   - signed-in requesters are governed by their in-app prefs, not the
 *     public list, and keep the in-app unsubscribe link,
 *   - public recipients get the signed /unsubscribe URL + RFC 8058
 *     one-click headers; with no UNSUBSCRIBE_SECRET the signer fails
 *     closed and the email falls back to the in-app link (no one-click
 *     header advertised for a URL that ignores POSTs).
 */

// vi.hoisted: the factory runs during hoisted imports, before top-level consts.
const envState = vi.hoisted(() => ({ UNSUBSCRIBE_SECRET: 'sender-test-secret-0123456789abcdef' }));
vi.mock('@/lib/env', () => ({ env: envState }));

interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  headers?: Record<string, string>;
}
const sendEmailMock = vi.fn(async (_args: SendEmailArgs) => ({ ok: true }));
vi.mock('./resend', () => ({
  sendEmail: (args: SendEmailArgs) => sendEmailMock(args),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => adminHolder.client),
}));

import { esEmailById } from './es/registry';
import { sendOrderRequestEmail, type OrderRequestEmailKind } from './order-requests';

const EMAIL = 'requester@school.edu';
const APP_URL = 'https://app.test';

function makeRow(overrides: Partial<OrderRequestRow> = {}): OrderRequestRow {
  return {
    id: '99999999-8888-7777-6666-555555555555',
    organization_id: 'org-1',
    warehouse_id: 'wh-1',
    status: 'approved',
    source: 'public_link',
    requester_user_id: null,
    requester_email: EMAIL,
    requester_name: 'Jane Teacher',
    fulfillment_type: 'pickup',
    delivery_charter_id: null,
    denied_reason: null,
    packing_slip_generated_at: null,
    approved_at: '2026-07-01T00:00:00Z',
    created_at: '2026-06-30T00:00:00Z',
    ...overrides,
  } as OrderRequestRow;
}

function wireAdmin(unsubscribed: boolean): SupabaseStub {
  const stub = makeSupabaseStub({
    'public_email_unsubscribes.select.maybeSingle': {
      data: unsubscribed ? { email: EMAIL } : null,
      error: null,
    },
  });
  adminHolder.client = stub.client;
  return stub;
}

describe('sendOrderRequestEmail — public unsubscribe enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.UNSUBSCRIBE_SECRET = 'sender-test-secret-0123456789abcdef';
    adminHolder.client = null;
  });

  it('skips a lifecycle email to an unsubscribed public recipient', async () => {
    const stub = wireAdmin(true);

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).not.toHaveBeenCalled();
    // Lookup runs against the canonical lowercased address.
    expect(stub.chainArgs.get('public_email_unsubscribes.select')).toEqual([
      ['email'],
      ['email', EMAIL],
    ]);
  });

  it('still sends confirm_request to an unsubscribed address (double-opt-in exemption)', async () => {
    wireAdmin(true);

    await sendOrderRequestEmail({
      kind: 'confirm_request',
      request: makeRow({ status: 'pending_confirmation' }),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
      confirmationToken: 'ab'.repeat(32),
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('sends to a non-unsubscribed public recipient with the signed one-click headers', async () => {
    wireAdmin(false);

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    const header = args.headers?.['List-Unsubscribe'] ?? '';
    expect(header).toMatch(
      new RegExp(`^<${APP_URL}/unsubscribe\\?e=${encodeURIComponent(EMAIL).replace('@', '%40')}&t=[0-9a-f]{64}>$`),
    );
    expect(args.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // The footer link in both bodies points at the public page, not the
    // login-gated dashboard prefs that dead-end anonymous recipients.
    expect(args.html).toContain('/unsubscribe?e=');
    expect(args.text).toContain('/unsubscribe?e=');
    expect(args.html).not.toContain('/dashboard/settings/notifications');
  });

  it('signed-in requesters are NOT suppressed by the public list and keep the in-app link', async () => {
    wireAdmin(true); // address is on the public list — must not matter

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow({ requester_user_id: 'user-1' }),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    expect(args.headers?.['List-Unsubscribe']).toBe(
      `<${APP_URL}/dashboard/settings/notifications?email=${encodeURIComponent(EMAIL)}>`,
    );
    // No one-click advertised for a login-gated page that ignores POSTs.
    expect(args.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('falls back to the in-app link (no one-click header) when UNSUBSCRIBE_SECRET is unset', async () => {
    envState.UNSUBSCRIBE_SECRET = '';
    wireAdmin(false);

    await sendOrderRequestEmail({
      kind: 'approved',
      request: makeRow(),
      recipientEmail: EMAIL,
      recipientName: 'Jane Teacher',
      appUrl: APP_URL,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    expect(args.headers?.['List-Unsubscribe']).toContain('/dashboard/settings/notifications');
    expect(args.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  });
});

// ─── es-layer rendering (Unit E4) ────────────────────────────────────

const LONG_ITEM_NAME =
  'Heavy-Duty Reinforced Corrugated Shipping Carton with Double-Wall Construction and Water-Resistant Coating — Pallet-Ready 24x18x18';

/** Full stub: unsubscribe list + summary tables (lines, warehouse, charter, approver). */
function wireFullAdmin(
  opts: {
    unsubscribed?: boolean;
    items?: { quantity_picked: number | null; quantity_requested: number | null; item: { name: string; sku: string } }[];
  } = {},
): SupabaseStub {
  const items = opts.items ?? [
    {
      quantity_picked: 4,
      quantity_requested: 6,
      item: { name: 'Blue Nitrile Gloves — Large', sku: 'GLV-BL-L' },
    },
    {
      quantity_picked: null,
      quantity_requested: 2,
      item: { name: 'Safety Goggles', sku: 'SG-01' },
    },
  ];
  const stub = makeSupabaseStub({
    'public_email_unsubscribes.select.maybeSingle': {
      data: opts.unsubscribed ? { email: EMAIL } : null,
      error: null,
    },
    'order_request_lines.select': { data: items, error: null },
    'warehouses.select.maybeSingle': {
      data: { name: 'Fresno DC', code: 'DCIV', address: { city: 'Fresno' } },
      error: null,
    },
    'charters.select.maybeSingle': {
      data: { name: 'Manchester', code: 'CVW' },
      error: null,
    },
    'user_profiles.select.maybeSingle': {
      data: { full_name: 'Morgan Diaz', email: 'morgan@l4l.org' },
      error: null,
    },
  });
  adminHolder.client = stub.client;
  return stub;
}

async function send(
  kind: OrderRequestEmailKind,
  rowOverrides: Partial<OrderRequestRow> = {},
  inputOverrides: Partial<Parameters<typeof sendOrderRequestEmail>[0]> = {},
): Promise<SendEmailArgs> {
  await sendOrderRequestEmail({
    kind,
    request: makeRow(rowOverrides),
    recipientEmail: EMAIL,
    recipientName: 'Jane Teacher',
    appUrl: APP_URL,
    ...(kind === 'confirm_request' ? { confirmationToken: 'ab'.repeat(32) } : {}),
    ...inputOverrides,
  });
  expect(sendEmailMock).toHaveBeenCalled();
  return sendEmailMock.mock.calls.at(-1)![0];
}

// Registry ids per dispatch kind (must stay in lockstep with the module).
const KIND_TO_ID: Record<OrderRequestEmailKind, string> = {
  submitted: 'received',
  confirm_request: 'confirm',
  approved: 'approved',
  denied: 'denied',
  packing_slip_generated: 'packing',
  staged_for_delivery: 'staged',
  in_transit: 'transit',
  completed: 'delivered',
  cancelled: 'cancelled',
};

const LIVE_KINDS: OrderRequestEmailKind[] = [
  'submitted',
  'confirm_request',
  'approved',
  'denied',
  'in_transit',
  'completed',
  'cancelled',
];
const LATENT_KINDS: OrderRequestEmailKind[] = [
  'packing_slip_generated',
  'staged_for_delivery',
];

// The row id 99999999-… → the existing WO- + 8-char handle.
const WO = 'WO-99999999';

// Byte-identical subject strings from the es registry (typographic
// apostrophes and em dashes are intentional — do not "fix" them).
const EXPECTED_SUBJECTS: Record<OrderRequestEmailKind, string> = {
  submitted: `${WO} received — we’re on it`,
  confirm_request: `Confirm ${WO} to send it to the warehouse`,
  approved: `${WO} is approved — packing has started`,
  denied: `${WO} wasn’t approved`,
  packing_slip_generated: `${WO} is being packaged`,
  staged_for_delivery: `${WO} is ready`,
  in_transit: `${WO} is on the way`,
  completed: `${WO} was delivered — thanks`,
  cancelled: `${WO} was cancelled`,
};

describe('sendOrderRequestEmail — es-layer rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.UNSUBSCRIBE_SECRET = 'sender-test-secret-0123456789abcdef';
    adminHolder.client = null;
    vi.unstubAllEnvs();
  });

  it('renders every live kind through the es shell with no merge debris', async () => {
    for (const kind of LIVE_KINDS) {
      vi.clearAllMocks();
      wireFullAdmin();
      const args = await send(kind, {
        approved_by: 'appr-1',
        denied_reason: kind === 'denied' ? 'Budget window closed for Q3.' : null,
      });

      expect(args.html).toContain('<!doctype html');
      expect(args.html).toContain('>Order Update</td>'); // brand-strip mono tag
      expect(args.html).toContain('Stock<span style="font-weight:500;opacity:0.6">Pilot</span>');
      // Merge hygiene: no undefined/NaN/handlebars braces, no raw UUID
      // rendered as element text (URLs may carry the id).
      expect(args.html).not.toContain('undefined');
      expect(args.html).not.toContain('NaN');
      expect(args.html).not.toContain('{{');
      expect(args.html).not.toContain('}}');
      expect(args.html).not.toContain('>99999999-8888-7777-6666-555555555555</');
      expect(args.text).not.toContain('undefined');
      expect(args.text?.length ?? 0).toBeGreaterThan(80);
      // The work-order handle appears in the body.
      expect(args.html).toContain(WO);
      // Registry sender rides the extended sendEmail `from` param.
      expect(args.from).toBe('StockPilot <orders@stockpilotusa.com>');
    }
  });

  it('subjects are byte-equal to the registry builders', async () => {
    vi.stubEnv('ES_LATENT_ORDER_EMAILS', '1');
    for (const kind of [...LIVE_KINDS, ...LATENT_KINDS]) {
      vi.clearAllMocks();
      wireFullAdmin();
      const args = await send(kind);
      expect(args.subject).toBe(EXPECTED_SUBJECTS[kind]);
      expect(args.subject).toBe(
        esEmailById(KIND_TO_ID[kind]).subject({ orderId: WO }),
      );
    }
  });

  it('latent kinds are fail-closed: no send without ES_LATENT_ORDER_EMAILS', async () => {
    for (const kind of LATENT_KINDS) {
      wireFullAdmin();
      await sendOrderRequestEmail({
        kind,
        request: makeRow(),
        recipientEmail: EMAIL,
        recipientName: 'Jane Teacher',
        appUrl: APP_URL,
      });
    }
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('latent templates render fully behind the flag (packing scanner, staged pin)', async () => {
    vi.stubEnv('ES_LATENT_ORDER_EMAILS', '1');

    wireFullAdmin();
    const packing = await send('packing_slip_generated');
    expect(packing.html).toContain('motion/scanner@2x.gif');
    expect(packing.html).toContain('is being packaged.');
    expect(packing.html).toContain('Units being prepared');

    vi.clearAllMocks();
    wireFullAdmin();
    const staged = await send('staged_for_delivery', {
      pickup_location_notes: 'Dock 3',
    });
    expect(staged.html).toContain('motion/pin@2x.gif');
    expect(staged.html).toContain('Signature required at the dock office');
    expect(staged.html).toContain('Dock 3');
    expect(staged.html).toContain('Pickup window');
  });

  it('denied: reason verbatim in a tonal err banner, no motion, no full-red', async () => {
    wireFullAdmin();
    const reason = `Budget < Q3 cap & "vendor" wasn't approved yet.`;
    const args = await send('denied', {
      status: 'denied',
      approved_by: 'appr-1',
      denied_reason: reason,
    });

    // Verbatim (HTML-escaped only) inside the err banner.
    expect(args.html).toContain(
      'Budget &lt; Q3 cap &amp; &quot;vendor&quot; wasn&#39;t approved yet.',
    );
    expect(args.html).toContain('Reason — from Morgan Diaz');
    // Tonal err pair from the tokens — banner bg + fg.
    expect(args.html).toContain('background:#f2e1dc');
    expect(args.html).toContain('#8a3d33');
    // Never the old full-red pair.
    expect(args.html).not.toContain('#f3dada');
    expect(args.html).not.toContain('#7a1f1f');
    // Intentionally static — no motion asset on a negative state.
    expect(args.html).not.toContain('motion/');
    // Terminal timeline stage.
    expect(args.html).toContain('Not approved');
    // Plaintext twin carries the reason verbatim.
    expect(args.text).toContain(reason);
  });

  it('confirm: essential footer, no unsubscribe in the body, headers unchanged', async () => {
    wireFullAdmin();
    const args = await send('confirm_request', { status: 'pending_confirmation' });

    // CTA points at the confirm route with the plaintext token.
    expect(args.html).toContain(`/r/confirm?id=99999999-8888-7777-6666-555555555555&amp;t=`);
    // Essential footer: Support/Privacy/Terms, no unsubscribe anchor.
    expect(args.html).toContain('can&rsquo;t be unsubscribed');
    expect(args.html).toContain(`${APP_URL}/privacy`);
    expect(args.html).toContain(`${APP_URL}/terms`);
    expect(args.html).not.toContain('>Unsubscribe</a>');
    expect(args.html).not.toContain('Manage email preferences');
    expect(args.html).not.toContain('/unsubscribe?e=');
    expect(args.html).not.toContain('/dashboard/settings/notifications');
    expect(args.text).not.toContain('/unsubscribe?e=');
    // Static hold state — no motion asset on confirm.
    expect(args.html).not.toContain('motion/');
    // Suppression/header machinery is untouched: the List-Unsubscribe
    // header still passes through exactly as before the redesign.
    expect(args.headers?.['List-Unsubscribe']).toBeDefined();
  });

  it('pref kinds: preference footer with manage + unsubscribe links and one-click headers', async () => {
    wireFullAdmin();
    const args = await send('approved', { approved_by: 'appr-1' });

    expect(args.html).toContain('>Manage email preferences</a>');
    expect(args.html).toContain('>Unsubscribe</a>');
    expect(args.html).toContain('Unsubscribing stops this notification type only');
    expect(args.html).toContain('/unsubscribe?e=');
    expect(args.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/app\.test\/unsubscribe\?e=/);
    expect(args.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Approved specifics: settle motion + timeline + approver attribution.
    expect(args.html).toContain('motion/settle@2x.gif');
    expect(args.html).toContain('by Morgan Diaz');
    expect(args.html).toContain('&#9679;<br>Approved');
  });

  it('delivered renders the item table for requester and signer sends alike', async () => {
    wireFullAdmin();
    const requesterCopy = await send('completed', {
      status: 'completed',
      signed_by_name: 'Dana Front-Desk',
      signed_at: '2026-07-02T15:04:00Z',
    });
    expect(requesterCopy.html).toContain('motion/check@2x.gif');
    expect(requesterCopy.html).toContain('Blue Nitrile Gloves — Large');
    expect(requesterCopy.html).toContain('GLV-BL-L');
    expect(requesterCopy.html).toContain('Total units');
    expect(requesterCopy.html).toContain('Dana Front-Desk');

    // Signer copy — same kind, different recipient (the sign route loops
    // recipients; the renderer must not assume the requester).
    vi.clearAllMocks();
    wireFullAdmin();
    const signerCopy = await send(
      'completed',
      { status: 'completed', signed_by_name: 'Dana Front-Desk' },
      { recipientEmail: 'signer@dock.test', recipientName: 'Dana Front-Desk' },
    );
    expect(signerCopy.to).toBe('signer@dock.test');
    expect(signerCopy.html).toContain('signer@dock.test');
  });

  it('cancelled: neutral, factual, no motion; timeline skips Approved when never approved', async () => {
    wireFullAdmin();
    const args = await send('cancelled', {
      status: 'cancelled',
      approved_at: null,
      cancelled_at: '2026-07-03T00:00:00Z',
    });
    expect(args.html).not.toContain('motion/');
    expect(args.html).toContain('neutralpill'); // neutral (not celebratory, not red) pill
    expect(args.html).toContain('&#9679; Cancelled');
    expect(args.html).toContain('Nothing further to do.');
    // Never-approved path renders no Approved timeline dot.
    expect(args.html).not.toContain('&#9679;<br>Approved');
    expect(args.html).toContain('Back to available stock');
  });

  it('stress: long values, missing ETA, and missing name degrade elegantly', async () => {
    // Long item name + long denial reason.
    wireFullAdmin({
      items: Array.from({ length: 12 }, (_, i) => ({
        quantity_picked: 3,
        quantity_requested: 3,
        item: { name: LONG_ITEM_NAME, sku: `SKU-${i.toString().padStart(4, '0')}` },
      })),
    });
    const longReason = `The requested quantities exceed the quarterly allocation for this site. ${'Reach out to your program coordinator before resubmitting. '.repeat(30)}`;
    const denied = await send('denied', {
      status: 'denied',
      denied_reason: longReason,
    });
    expect(denied.html).toContain('quarterly allocation');
    // Preheader carries a truncated summary, not the 2KB reason.
    expect(denied.html).toContain('…');
    expect(denied.html).toContain('You can revise and resubmit.');
    expect(denied.html).not.toContain('undefined');

    // Missing ETA → "soon" fallback (no empty clause, no undefined).
    vi.clearAllMocks();
    wireFullAdmin();
    const transit = await send('in_transit', { needed_by: null });
    expect(transit.html).toContain('Estimated soon.');
    expect(transit.html).toContain('estimated soon at');
    expect(transit.html).not.toContain('undefined');

    // Missing name → the design's "Hi —" fallback.
    vi.clearAllMocks();
    wireFullAdmin();
    const noName = await send('submitted', {}, { recipientName: null });
    expect(noName.html).toContain('Hi — ');
    expect(noName.text).toContain('Hi — ');
  });

  it('stays comfortably under the Gmail clip budget with maximal content', async () => {
    vi.stubEnv('ES_LATENT_ORDER_EMAILS', '1');
    const kinds: OrderRequestEmailKind[] = [...LIVE_KINDS, ...LATENT_KINDS];
    for (const kind of kinds) {
      vi.clearAllMocks();
      wireFullAdmin({
        items: Array.from({ length: 40 }, (_, i) => ({
          quantity_picked: 5,
          quantity_requested: 5,
          item: { name: LONG_ITEM_NAME, sku: `LONG-SKU-${i}-WITH-SUFFIX` },
        })),
      });
      const args = await send(kind, {
        denied_reason: kind === 'denied' ? 'x'.repeat(3000) : null,
        pickup_location_notes: 'Dock 3 — north gate, badge required',
      });
      expect(Buffer.byteLength(args.html, 'utf8')).toBeLessThan(102 * 1024);
    }
  });

  it('caps the item table at 30 rows so huge orders still send', async () => {
    // Uncapped, a ~150-line order pushed the render past the 102KB budget:
    // assertEmailWeight threw inside sendOrderRequestEmail and every
    // dispatch path swallows that throw — the recipient silently got
    // nothing. The cap + overflow note keeps the send alive.
    wireFullAdmin({
      items: Array.from({ length: 150 }, (_, i) => ({
        quantity_picked: 5,
        quantity_requested: 5,
        item: { name: LONG_ITEM_NAME, sku: `LONG-SKU-${i}-WITH-SUFFIX` },
      })),
    });
    const args = await send('completed', { status: 'completed' });
    expect(args.html).toContain('+ 120 more lines');
    expect(args.html).toContain('LONG-SKU-29-');
    expect(args.html).not.toContain('LONG-SKU-30-');
    expect(Buffer.byteLength(args.html, 'utf8')).toBeLessThan(102 * 1024);
  });

  it('staff cancel of a public-link order reads "by the team", self-cancel keeps "the requester"', async () => {
    // makeRow is a public order (requester_user_id null): an authenticated
    // canceller can only be staff, and the old guard wrongly blamed the
    // requester whenever requester_user_id was null.
    wireFullAdmin();
    const staffCancel = await send('cancelled', {
      status: 'cancelled',
      cancelled_at: '2026-07-03T00:00:00Z',
      cancelled_by: 'aaaaaaaa-1111-2222-3333-444444444444',
    });
    expect(staffCancel.html).toContain('by the team');
    expect(staffCancel.html).not.toContain('by the requester');

    vi.clearAllMocks();
    wireFullAdmin();
    const selfCancel = await send('cancelled', {
      status: 'cancelled',
      cancelled_at: '2026-07-03T00:00:00Z',
      cancelled_by: null,
    });
    expect(selfCancel.html).toContain('by the requester');
  });

  it('in_transit hero alt escapes the public requester name (attribute context)', async () => {
    // shipTo for a pickup order is requester_name — anonymous public-form
    // input. Unescaped, a double quote terminates the alt attribute.
    wireFullAdmin();
    const args = await send('in_transit', {
      requester_name: 'Dana "Dee" Reyes & Co',
    });
    expect(args.html).toContain('en route to Dana &quot;Dee&quot; Reyes &amp; Co');
    expect(args.html).not.toContain('to Dana "Dee"');
  });
});
