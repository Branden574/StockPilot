import { beforeEach, describe, expect, it, vi } from 'vitest';

import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * B23: a support ticket names both its organization and the member who filed
 * it (the dashboard, the phone) or neither (the public support page). The
 * resolved notice decides that a member deleted their account from "an
 * organization and nobody" (server/lib/kept-address.ts), so a ticket written
 * with half an owner would never get its notice. createSupportTicket used to
 * write whatever pair it was handed; it now refuses half an owner before the
 * insert.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock('@/lib/email/resend', () => ({ sendEmail }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
const adminHandle = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));

import { createSupportTicket } from './support-tickets';

const BASE = {
  name: 'Test Member',
  email: 'member@example.com',
  category: 'bug' as const,
  subject: 'The scanner does not open',
  message: 'It shows a blank screen after the update.',
};

function withInsert() {
  const inserts: MockCall[] = [];
  const stub = makeSupabaseStub({
    'support_tickets.insert': (call) => {
      inserts.push(call);
      return { data: { id: 'a1b2c3d4-0000-4000-8000-000000000000' }, error: null };
    },
  });
  adminHandle.client = stub.client;
  return { inserts };
}

function inserted(call: MockCall): Record<string, unknown> {
  return (callArgs(call, 'insert')?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  sendEmail.mockClear();
});

describe('createSupportTicket: the owner pair', () => {
  it('writes both for a ticket a member filed in the app', async () => {
    const { inserts } = withInsert();
    await createSupportTicket({ ...BASE, organizationId: 'org-1', submittedBy: 'member-1' });
    expect(inserts).toHaveLength(1);
    expect(inserted(inserts[0]!)).toMatchObject({
      organization_id: 'org-1',
      submitted_by: 'member-1',
    });
  });

  it('writes neither for a public ticket', async () => {
    const { inserts } = withInsert();
    await createSupportTicket(BASE);
    expect(inserted(inserts[0]!)).toMatchObject({ organization_id: null, submitted_by: null });
  });

  it('refuses an organization with nobody, and writes nothing (mutation: drop the check)', async () => {
    const { inserts } = withInsert();
    await expect(createSupportTicket({ ...BASE, organizationId: 'org-1' })).rejects.toThrow(
      /both .* or neither/,
    );
    expect(inserts).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a member with no organization, and writes nothing', async () => {
    const { inserts } = withInsert();
    await expect(createSupportTicket({ ...BASE, submittedBy: 'member-1' })).rejects.toThrow(
      /both .* or neither/,
    );
    expect(inserts).toHaveLength(0);
  });
});
