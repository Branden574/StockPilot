import { beforeEach, describe, expect, it, vi } from 'vitest';

import { esEmailById } from '@/lib/email/es/registry';
import { makeSupabaseStub } from '@/test/supabase-mock';

import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
  sendPartialReceiptEmail,
} from './order-handover-notify';

/**
 * Unit E5 wiring tests for the hand-over notices. Load-bearing:
 *
 *   • the email_order_completed OPT-OUT GATE is untouched — the email
 *     sends iff `requesterEmail && !emailOptedOut`, exactly as before
 *     (the in-app notification is independent of the email gate);
 *   • subjects stay byte-identical to the registry builders (and to the
 *     pre-redesign production subjects);
 *   • the redesigned senders ride from: orders@stockpilotusa.com, and
 *     the signer receipt builds its "<org> via StockPilot" display-from
 *     from the organization name;
 *   • best-effort posture: a failing send never rejects.
 */

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }));

const createNotificationMock = vi.hoisted(() => vi.fn(async (_args: unknown) => {}));
vi.mock('@/server/services/notifications', () => ({
  createNotification: createNotificationMock,
}));

const adminStubRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (!adminStubRef.current) throw new Error('no admin stub configured');
    return adminStubRef.current;
  },
}));

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_NO = '#22222222';
const ORG_ID = 'org-test';
const APP_URL = 'https://app.example.com';

const LINES = {
  data: [
    {
      quantity_requested: 12,
      quantity_fulfilled: 12,
      inventory_items: { name: 'Field Radio', sku: 'RAD-001' },
    },
    {
      quantity_requested: 8,
      quantity_fulfilled: 0,
      inventory_items: { name: 'Insulated Bottle 24 oz', sku: 'DRK-BTL-024' },
    },
  ],
  error: null,
};

function wireAdmin(overrides: Record<string, unknown> = {}) {
  const stub = makeSupabaseStub({
    'order_request_lines.select': LINES,
    'organizations.select': { data: [{ name: 'L4L North Region' }], error: null },
    ...overrides,
  });
  adminStubRef.current = stub.client;
  return stub;
}

function backorderedArgs(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_ID,
    orderId: ORDER_ID,
    requesterUserId: 'user-1',
    requesterEmail: 'req@example.com',
    requesterName: 'Reggie Requester',
    appUrl: APP_URL,
    provided: 12,
    requested: 20,
    owed: 8,
    emailOptedOut: false,
    ...overrides,
  };
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true });
  createNotificationMock.mockClear();
  wireAdmin();
});

describe('notifyRequesterBackordered (partial)', () => {
  it('sends the es partial email: registry subject, orders@ sender, unsubscribe header', async () => {
    await notifyRequesterBackordered(backorderedArgs());

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
      from: string;
      headers: Record<string, string>;
    };
    expect(args.to).toBe('req@example.com');
    // Byte-identical to the registry AND to the pre-redesign subject.
    expect(args.subject).toBe(esEmailById('partial').subject({ orderNumber: ORDER_NO }));
    expect(args.subject).toBe(`Order ${ORDER_NO}: partially fulfilled`);
    expect(args.from).toBe('StockPilot <orders@stockpilotusa.com>');
    expect(args.headers['List-Unsubscribe']).toBeDefined();
    // Split stat cards + the per-line status column from the admin fetch.
    expect(args.html).toContain('Partially fulfilled');
    expect(args.html).toContain('Field Radio');
    expect(args.html).toContain('8 backordered');
    expect(args.text).toContain('12 of 20 units were delivered');

    // In-app notification untouched.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const notif = createNotificationMock.mock.calls[0]![0] as { title: string; type: string };
    expect(notif.type).toBe('order_backordered');
    expect(notif.title).toBe(`Order ${ORDER_NO}: partially fulfilled`);
  });

  it('OPT-OUT GATE UNTOUCHED: emailOptedOut suppresses the email but not the in-app notice', async () => {
    await notifyRequesterBackordered(backorderedArgs({ emailOptedOut: true }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('no requester email → no send (public order with no address)', async () => {
    await notifyRequesterBackordered(backorderedArgs({ requesterEmail: null }));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('still emails when the line fetch fails (degraded template, best-effort)', async () => {
    adminStubRef.current = null; // createAdminClient throws → fetch returns []
    await notifyRequesterBackordered(backorderedArgs());
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(args.html).not.toContain('Field Radio');
    expect(args.html).toContain('Partially fulfilled');
  });

  it('BEST-EFFORT: resolves when the send throws', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('resend down'));
    await expect(notifyRequesterBackordered(backorderedArgs())).resolves.toBeUndefined();
  });
});

describe('notifyRequesterBackorderShipped (back-shipped)', () => {
  const shippedArgs = (overrides: Record<string, unknown> = {}) => ({
    organizationId: ORG_ID,
    orderId: ORDER_ID,
    requesterUserId: 'user-1',
    requesterEmail: 'req@example.com',
    requesterName: 'Reggie Requester',
    appUrl: APP_URL,
    emailOptedOut: false,
    unitsShipped: 8,
    ...overrides,
  });

  it('sends the es back-shipped email with the route motion asset', async () => {
    await notifyRequesterBackorderShipped(shippedArgs());
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0] as {
      subject: string;
      html: string;
      from: string;
      headers: Record<string, string>;
    };
    expect(args.subject).toBe(
      esEmailById('back-shipped').subject({ orderNumber: ORDER_NO }),
    );
    expect(args.subject).toBe(`Order ${ORDER_NO}: backordered items shipped`);
    expect(args.from).toBe('StockPilot <orders@stockpilotusa.com>');
    expect(args.html).toContain('https://stockpilotusa.com/email/motion/route@2x.gif');
    expect(args.html).toContain('The last 8 units are moving.');
    expect(args.headers['List-Unsubscribe']).toBeDefined();
  });

  it('OPT-OUT GATE UNTOUCHED: opted-out requester gets no email, keeps the in-app notice', async () => {
    await notifyRequesterBackorderShipped(shippedArgs({ emailOptedOut: true }));
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('works without unitsShipped (older callers)', async () => {
    await notifyRequesterBackorderShipped(shippedArgs({ unitsShipped: undefined }));
    const args = sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(args.html).toContain('The rest of your order is moving.');
  });
});

describe('sendPartialReceiptEmail (partial-receipt)', () => {
  const receiptArgs = () => ({
    organizationId: ORG_ID,
    orderId: ORDER_ID,
    to: 'signer@example.com',
    signerName: 'M. Okafor',
    unitsReceived: 12,
    unitsTotal: 20,
    unitsPending: 8,
    appUrl: APP_URL,
  });

  it('sends the external receipt from "<org> via StockPilot" with no unsubscribe', async () => {
    await sendPartialReceiptEmail(receiptArgs());
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      from: string;
      headers?: Record<string, string>;
    };
    expect(args.to).toBe('signer@example.com');
    expect(args.subject).toBe(
      esEmailById('partial-receipt').subject({ orderNumber: ORDER_NO }),
    );
    expect(args.subject).toBe(`Order ${ORDER_NO}: partial delivery receipt`);
    expect(args.from).toBe('L4L North Region via StockPilot <orders@stockpilotusa.com>');
    // External one-time receipt: no unsubscribe link, no List-Unsubscribe.
    expect(args.html).not.toContain('Unsubscribe');
    expect(args.headers).toBeUndefined();
    expect(args.html).toContain('M. Okafor');
    expect(args.html).toContain('12 of 20');
    expect(args.html).toContain('L4L North Region &middot; via StockPilot');
  });

  it('falls back to the plain StockPilot sender when the org name is unavailable', async () => {
    wireAdmin({ 'organizations.select': { data: [], error: null } });
    await sendPartialReceiptEmail(receiptArgs());
    const args = sendEmailMock.mock.calls[0]![0] as { from: string; html: string };
    expect(args.from).toBe('StockPilot <orders@stockpilotusa.com>');
    expect(args.html).toContain(
      'one-time receipt because you signed for a delivery managed through StockPilot',
    );
  });
});
