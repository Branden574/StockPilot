import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Rental email dispatch (lib/email/rentals.ts) — the layer between the
 * rental service/cron and the es-family renderers. Pins:
 *   - the borrower-absent skip (no email on file → no send, no throw),
 *   - the registry sender (rentals@) and subjects on the wire,
 *   - NO List-Unsubscribe headers (essential footer per the rental
 *     classification decision — nothing to unsubscribe from),
 *   - best-effort semantics (DB/send failures never throw).
 */

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://stockpilotusa.com' },
}));

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

import {
  sendRentalCheckoutEmail,
  sendRentalOverdueEmail,
  sendRentalReturnedEmail,
} from './rentals';

const RENTAL_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  organization_id: 'org-1',
  borrower_user_id: 'user-1',
  borrower_name: 'Theo Marsh',
  borrower_email: 'theo@l4l.example',
  checked_out_at: '2026-06-02T17:15:00Z',
  expected_return_at: '2026-06-09T19:00:00Z',
  returned_at: '2026-06-08T23:05:00Z',
  warehouse_id: 'wh-1',
  status: 'out',
  notes: 'Both units charged and bagged.',
};

function stubFor(overrides: Partial<Record<keyof typeof RENTAL_ROW, unknown>> = {}) {
  return makeSupabaseStub({
    'rentals.select': { data: [{ ...RENTAL_ROW, ...overrides }], error: null },
    'rental_lines.select': {
      data: [
        {
          item_id: 'item-1',
          quantity: 2,
          inventory_items: { name: 'Handheld Scanner Z-220', sku: 'AST-0142' },
        },
      ],
      error: null,
    },
    'organizations.select': { data: [{ name: 'L4L North Region' }], error: null },
    'warehouses.select': { data: [{ name: 'DCIV — Fresno' }], error: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rental email dispatch', () => {
  it('sends checkout email from rentals@ with the registry subject and no unsubscribe headers', async () => {
    adminHolder.client = stubFor().client;
    await sendRentalCheckoutEmail(RENTAL_ROW.id);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0]![0];
    expect(args.to).toBe('theo@l4l.example');
    expect(args.subject).toBe('Your rental is checked out');
    expect(args.from).toBe('StockPilot <rentals@stockpilotusa.com>');
    expect(args.headers).toBeUndefined();
    expect(args.html).toContain('Handheld Scanner Z-220');
    expect(args.html).toContain('DCIV — Fresno');
    // Signed-in borrower → CTA links the rental detail page.
    expect(args.html).toContain(
      `https://stockpilotusa.com/dashboard/rentals/${RENTAL_ROW.id}`,
    );
    // Essential footer per policy — never a preference/unsubscribe link.
    expect(args.html).not.toContain('Unsubscribe');
  });

  it('sends returned + overdue variants with their registry subjects', async () => {
    adminHolder.client = stubFor().client;
    await sendRentalReturnedEmail(RENTAL_ROW.id);
    adminHolder.client = stubFor().client;
    await sendRentalOverdueEmail(RENTAL_ROW.id);

    const subjects = sendEmailMock.mock.calls.map((c) => c[0].subject);
    expect(subjects).toEqual([
      'Thanks — your rental has been returned',
      'Reminder: your rental is overdue',
    ]);
    const overdueHtml = sendEmailMock.mock.calls[1]![0].html;
    expect(overdueHtml).toContain('clock-arc@2x.gif');
    // Real day counts from real dates (expected_return_at is in the past).
    expect(overdueHtml).toMatch(/Overdue · \d+ days?/);
  });

  it('skips silently when the rental has no borrower email (unchanged behavior)', async () => {
    adminHolder.client = stubFor({ borrower_email: null }).client;
    await expect(sendRentalCheckoutEmail(RENTAL_ROW.id)).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('omits the CTA for external borrowers (no account, no public rental page)', async () => {
    adminHolder.client = stubFor({ borrower_user_id: null }).client;
    await sendRentalCheckoutEmail(RENTAL_ROW.id);
    const args = sendEmailMock.mock.calls[0]![0];
    expect(args.html).not.toContain('/dashboard/rentals/');
    expect(args.html).not.toContain('View rental');
  });

  it('never throws — a load failure logs and returns', async () => {
    adminHolder.client = makeSupabaseStub({
      'rentals.select': { data: null, error: { message: 'boom' } },
    }).client;
    await expect(sendRentalOverdueEmail(RENTAL_ROW.id)).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('never throws — a send failure is swallowed', async () => {
    adminHolder.client = stubFor().client;
    sendEmailMock.mockRejectedValueOnce(new Error('resend down'));
    await expect(sendRentalCheckoutEmail(RENTAL_ROW.id)).resolves.toBeUndefined();
  });
});
