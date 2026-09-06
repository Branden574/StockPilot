import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Wire-level: CustomersService.inviteUser must mint the magic link exactly
// as before (admin.generateLink, NEVER inviteUserByEmail) and deliver the
// es portal-invite — branded "<Org> via StockPilot", replies to the
// inviting supplier user.

const sendEmail = vi.fn();
const generateLink = vi.fn();

vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const adminStub = makeSupabaseStub({
  // No dashboard members share the invitee's address.
  'organization_members.select': { data: [], error: null },
});
(adminStub.client.auth as { admin?: unknown }).admin = { generateLink };

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminStub.client,
}));

import { CustomersService } from './customers';

function makeService() {
  const stub = makeSupabaseStub({
    // Serves BOTH assertPlanAllows (billing fields) and the sender-identity
    // read (name) — same row either way.
    'organizations.select': {
      data: { name: 'L4L North Region', plan: null, access_tier: 'business' },
      error: null,
    },
    'customers.select': {
      data: { id: 'cust-1', name: 'Harbor & Pine Outfitters' },
      error: null,
    },
    'customer_users.insert': { data: null, error: null },
    'user_profiles.select': { data: { email: 'branden@l4lnorth.com' }, error: null },
  });
  const ctx = makeServiceContext(stub.client, {
    role: 'admin',
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'b2b_portal']),
  });
  return { svc: new CustomersService(ctx as never), stub };
}

describe('CustomersService.inviteUser — es portal-invite wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash999' }, user: { id: 'auth-user-1' } },
      error: null,
    });
  });

  it('mints via generateLink and sends the branded external invite', async () => {
    const { svc } = makeService();
    await svc.inviteUser('cust-1', 'Maya@HarborPine.example');

    // Mint logic untouched: invite first, no built-in mailer.
    expect(generateLink).toHaveBeenCalledWith({
      type: 'invite',
      email: 'maya@harborpine.example',
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      from?: string;
      replyTo?: string;
    };
    expect(msg.to).toBe('maya@harborpine.example');
    // Registry sender: supplier-branded portal@ + replies to the supplier.
    expect(msg.from).toBe('L4L North Region via StockPilot <portal@stockpilotusa.com>');
    expect(msg.replyTo).toBe('branden@l4lnorth.com');
    // Registry subject, byte-equal (supplier org, not the customer record).
    expect(msg.subject).toBe(
      'You’re invited to order from L4L North Region’s supplier portal',
    );
    // The magic link still routes through our server-verified confirm page.
    expect(msg.html).toContain('/auth/confirm?token_hash=hash999&amp;type=invite');
    expect(msg.html).toContain('How this link works');
  });

  it('throws when the invite email fails to send (was silently fail-open)', async () => {
    sendEmail.mockResolvedValue({ ok: false, error: 'resend down' });
    const { svc } = makeService();
    await expect(svc.inviteUser('cust-1', 'maya@harborpine.example')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

// SP-136: email validity used to be decided by a hand-rolled regex here
// (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) while every action schema that fronts this
// service parses with core `emailSchema` (zod). The two rules disagree, so the
// service accepted addresses the rest of the app refuses — a second entry point
// (or a future caller without a zod-parsing action in front of it) would have
// minted a magic link for an address no other layer considers valid. One rule
// now: core emailSchema, the same object the action schemas use.
describe('CustomersService.inviteUser — email validity is the core emailSchema rule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash999' }, user: { id: 'auth-user-1' } },
      error: null,
    });
  });

  // Each of these PASSES the old hand regex and FAILS zod's email rule.
  it.each([
    ['single-letter TLD', 'j.doe@school.c'],
    ['consecutive dots in the local part', 'john..smith@acme.com'],
    ['leading dot in the local part', '.lead@acme.com'],
    ['local part past 254 chars', `${'a'.repeat(300)}@acme.com`],
  ])('refuses %s (%s) before minting a link', async (_label, email) => {
    const { svc } = makeService();
    await expect(svc.inviteUser('cust-1', email)).rejects.toMatchObject({
      code: 'validation_error',
    });
    // No auth user created, no mail sent for an address the app calls invalid.
    expect(generateLink).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('still accepts a normal address (guards against an over-strict rule)', async () => {
    const { svc } = makeService();
    await expect(svc.inviteUser('cust-1', '  Maya.Ortiz+orders@Harbor-Pine.example  ')).resolves.toBeUndefined();
    expect(generateLink).toHaveBeenCalledWith({
      type: 'invite',
      email: 'maya.ortiz+orders@harbor-pine.example',
    });
  });
});
