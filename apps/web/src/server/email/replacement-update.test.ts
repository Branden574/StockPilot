import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The exchange replacement order's emails (returns RX-2, plan 3.6.7, A-3):
 * which order emails a replacement sends (reworded), which it never sends,
 * where the button goes (never a link built from a missing token, never the
 * requester's token page to someone else), and the requester's completion
 * left to the return prompt's replacement branch.
 */

const sendEmailMock = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ ok: true })));
vi.mock('@/lib/email/resend', () => ({ sendEmail: sendEmailMock }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

const resolveReturnTokenMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => 'tok-orig'));
vi.mock('@/server/lib/order-secrets', () => ({ resolveReturnToken: resolveReturnTokenMock }));

import { replacementEventForOrderEmail, replacementViewUrl, sendReplacementOrderEmail } from './replacement-update';

const APP = 'https://app.example.com';
const RMA = { id: 'rma-1', return_number: 'RMA-20261005-ABC123', status: 'approved', order_request_id: 'orig', order_request: { order_number: 103 } };

function admin(rma = RMA, profileEmail: string | null = null) {
  return makeSupabaseStub({
    'returns.select': { data: [rma], error: null },
    'user_profiles.select': { data: profileEmail ? [{ email: profileEmail }] : [], error: null },
    'public_email_unsubscribes.select': { data: [], error: null },
  }).client;
}

const EMAIL_ONLY = { id: 'repl-1', source: 'internal', requester_user_id: null, requester_email: 'pat@example.com', replacement_for_return_id: 'rma-1' };

beforeEach(() => {
  sendEmailMock.mockClear();
  resolveReturnTokenMock.mockClear();
  resolveReturnTokenMock.mockResolvedValue('tok-orig');
});

describe('replacementEventForOrderEmail', () => {
  it('rewords staged for delivery, in transit, a partial hand-over and the completion; never the rest', () => {
    const open = { returnStatus: 'approved' };
    expect(replacementEventForOrderEmail('staged_for_delivery', open)).toBe('replacement_ready_delivery');
    expect(replacementEventForOrderEmail('in_transit', open)).toBe('replacement_on_the_way');
    expect(replacementEventForOrderEmail('backordered', open)).toBe('replacement_partly_handed_over');
    expect(replacementEventForOrderEmail('completed', open)).toBe('replacement_handed_over');
    expect(replacementEventForOrderEmail('completed', { returnStatus: 'closed' })).toBe('exchange_complete');
    for (const kind of ['submitted', 'confirm_request', 'approved', 'denied', 'cancelled', 'packing_slip_generated']) {
      expect(replacementEventForOrderEmail(kind, open)).toBeNull();
    }
  });
});

describe('replacementViewUrl (A-3)', () => {
  const facts = { returnId: 'rma-1', returnNumber: 'RMA-1', returnStatus: 'approved', originalOrderId: 'orig', originalOrderNumber: 103 };

  it('member: the replacement in the app; portal: /portal; email-only: the RMA token page they hold', async () => {
    expect(await replacementViewUrl(admin(), { ...EMAIL_ONLY, requester_user_id: 'u1' }, facts, APP)).toBe(`${APP}/dashboard/orders/repl-1`);
    expect(await replacementViewUrl(admin(), { ...EMAIL_ONLY, source: 'portal', requester_user_id: 'pu' }, facts, APP)).toBe(`${APP}/portal`);
    expect(await replacementViewUrl(admin(), EMAIL_ONLY, facts, APP)).toBe(`${APP}/returns/request/tok-orig`);
    expect(resolveReturnTokenMock).toHaveBeenCalledWith(expect.anything(), 'orig');
  });

  it('no token: no link (never one built from a missing token)', async () => {
    resolveReturnTokenMock.mockResolvedValueOnce(null);
    expect(await replacementViewUrl(admin(), EMAIL_ONLY, facts, APP)).toBeNull();
  });
});

describe('sendReplacementOrderEmail', () => {
  it('in transit to an email-only requester: reworded, with the RMA token page', async () => {
    const out = await sendReplacementOrderEmail(admin(), { order: EMAIL_ONLY, kind: 'in_transit', to: 'pat@example.com', recipientName: 'Pat', appUrl: APP });
    expect(out).toBe('sent');
    const mail = sendEmailMock.mock.calls[0]![0] as unknown as { subject: string; text: string };
    expect(mail.subject).toBe('Return RMA-20261005-ABC123: replacement on the way');
    expect(mail.text).toContain('Your replacement is on the way.');
    expect(mail.text).toContain(`${APP}/returns/request/tok-orig`);
    expect(mail.text).not.toMatch(/\/r\/track/);
  });

  it('the received and approved order emails are never sent for a replacement', async () => {
    for (const kind of ['submitted', 'approved', 'cancelled', 'denied', 'packing_slip_generated']) {
      expect(await sendReplacementOrderEmail(admin(), { order: EMAIL_ONLY, kind, to: 'pat@example.com', recipientName: null, appUrl: APP })).toBe('skipped');
    }
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('completion: the requester gets nothing here (the return prompt sends it); another signer gets a receipt without a link', async () => {
    expect(
      await sendReplacementOrderEmail(admin(), { order: EMAIL_ONLY, kind: 'completed', to: 'PAT@example.com', recipientName: null, appUrl: APP }),
    ).toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(
      await sendReplacementOrderEmail(admin(), { order: EMAIL_ONLY, kind: 'completed', to: 'front.desk@example.com', recipientName: null, appUrl: APP }),
    ).toBe('sent');
    const mail = sendEmailMock.mock.calls[0]![0] as unknown as { text: string; html: string };
    expect(mail.text).toContain('Your replacement was handed over.');
    expect(mail.text).not.toContain('tok-orig');
    expect(mail.html).not.toContain('tok-orig');
  });

  it("a member requester's own address comes from the profile (the row has none)", async () => {
    const member = { ...EMAIL_ONLY, requester_user_id: 'u1', requester_email: null };
    expect(
      await sendReplacementOrderEmail(admin(RMA, 'member@example.com'), { order: member, kind: 'completed', to: 'member@example.com', recipientName: null, appUrl: APP }),
    ).toBe('skipped');
  });

  it('an ordinary order (no link) or an unreadable RMA sends nothing here', async () => {
    expect(
      await sendReplacementOrderEmail(admin(), { order: { ...EMAIL_ONLY, replacement_for_return_id: null }, kind: 'in_transit', to: 'x@example.com', recipientName: null, appUrl: APP }),
    ).toBe('skipped');
    const broken = makeSupabaseStub({ 'returns.select': { data: null, error: { message: 'boom' } } }).client;
    expect(await sendReplacementOrderEmail(broken, { order: EMAIL_ONLY, kind: 'in_transit', to: 'x@example.com', recipientName: null, appUrl: APP })).toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
