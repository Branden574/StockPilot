import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * B23: the "your ticket is resolved" email goes to the address kept on the
 * ticket, never to the live account. A ticket filed in the app (the dashboard
 * action, the phone's /api/v1/support) always names its organization and the
 * member who filed it; a public one names neither. support_tickets.submitted_by
 * is nulled by the user_profiles foreign key only when that member deletes
 * their account, so an in-app ticket that names an organization and nobody is
 * a deleted member's, and the kept address is never emailed again (A3).
 * Before this fix the notice went out regardless.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/lib/email/resend', () => ({ sendEmail }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const adminHandle = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));

import { updateSupportTicket } from './support-tickets';

const TICKET = 'ticket-1';
const KEPT = 'member@example.com';

function ticket(over: Record<string, unknown>) {
  return {
    status: 'open',
    email: KEPT,
    name: 'Test Member',
    subject: 'The scanner does not open',
    organization_id: 'org-1',
    submitted_by: 'member-1',
    ...over,
  };
}

function withTicket(row: Record<string, unknown>) {
  const reads: MockCall[] = [];
  const stub = makeSupabaseStub({
    'support_tickets.select': (call) => {
      reads.push(call);
      return { data: row, error: null };
    },
    'support_tickets.update': { data: null, error: null },
  });
  adminHandle.client = stub.client;
  return { reads };
}

/** The notice is fire-and-forget: let it run before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sendEmail.mockClear();
});

describe('updateSupportTicket: the resolved notice', () => {
  it('reads who filed the ticket with the rest of it', async () => {
    const { reads } = withTicket(ticket({}));
    await updateSupportTicket(TICKET, { status: 'resolved' });
    const columns = String(callArgs(reads[0]!, 'select')?.[0] ?? '');
    expect(columns).toMatch(/\borganization_id\b/);
    expect(columns).toMatch(/\bsubmitted_by\b/);
  });

  it('emails the member who filed an in-app ticket', async () => {
    withTicket(ticket({}));
    await updateSupportTicket(TICKET, { status: 'resolved' });
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({ to: KEPT });
  });

  it('emails a public ticket, which never names an organization or a member', async () => {
    withTicket(ticket({ organization_id: null, submitted_by: null }));
    await updateSupportTicket(TICKET, { status: 'resolved' });
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('never emails the kept address of a member who deleted their account (mutation: drop the check)', async () => {
    withTicket(ticket({ submitted_by: null }));
    await updateSupportTicket(TICKET, { status: 'resolved' });
    await settle();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
