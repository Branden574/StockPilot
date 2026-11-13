import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Wire-level: CustomersService.inviteUser must mint the magic link exactly
// as before (admin.generateLink, NEVER inviteUserByEmail) and deliver the
// es portal-invite — branded "<Org> via StockPilot", replies to the
// inviting supplier user.
//
// Docket S25: the link carries `r`, the account it is for, signed with the
// link's own type (invite, or magiclink for an existing account) for the user
// id GoTrue returned (checked with the app's own checker). A link that cannot
// be signed is refused BEFORE the person is mapped to the customer. The
// signing value is a dull one under a neutral name, set before @/lib/env reads
// the environment (src/test/secret-shaped-fixtures.guard.test.ts).
vi.hoisted(() => {
  const SIGNING_INPUT = 'test-only-signing-input';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_INPUT;
});

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

import { env } from '@/lib/env';
import { emailedConfirmLink } from '@/test/confirm-link-check';

import { CustomersService } from './customers';

/** The invitee's auth user, as GoTrue's generateLink returns it. */
const INVITEE_ID = '33333333-3333-4333-8333-333333333333';
/** GoTrue's hashed token is a sha224 in hex: 56 characters. */
const LINK_HASH = 'ab'.repeat(28);
const SIGNING_COPY = env.SUPABASE_SERVICE_ROLE_KEY;

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
    'user_profiles.select': { data: { email: 'carsten@north.example' }, error: null },
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
    env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_COPY;
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: LINK_HASH }, user: { id: INVITEE_ID } },
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
      text: string;
      from?: string;
      replyTo?: string;
    };
    expect(msg.to).toBe('maya@harborpine.example');
    // Registry sender: supplier-branded portal@ + replies to the supplier.
    expect(msg.from).toBe('L4L North Region via StockPilot <portal@stockpilotusa.com>');
    expect(msg.replyTo).toBe('carsten@north.example');
    // Registry subject, byte-equal (supplier org, not the customer record).
    expect(msg.subject).toBe(
      'You’re invited to order from L4L North Region’s supplier portal',
    );
    // The magic link still routes through our server-verified confirm page.
    expect(msg.html).toContain(`/auth/confirm?token_hash=${LINK_HASH}&amp;type=invite`);
    expect(msg.html).toContain('How this link works');
    // S25: the page will name the invitee, the account GoTrue made the link for.
    expect(emailedConfirmLink(msg.text)).toMatchObject({
      type: 'invite',
      next: '/portal',
      recipient: INVITEE_ID,
    });
  });

  it('an existing account gets a sign-in link, signed as one (never valid as an invite)', async () => {
    generateLink
      .mockResolvedValueOnce({
        data: { properties: null, user: null },
        error: { message: 'A user with this email address has already been registered' },
      })
      .mockResolvedValueOnce({
        data: { properties: { hashed_token: LINK_HASH }, user: { id: INVITEE_ID } },
        error: null,
      });
    const { svc } = makeService();
    await svc.inviteUser('cust-1', 'maya@harborpine.example');
    expect(generateLink).toHaveBeenNthCalledWith(2, {
      type: 'magiclink',
      email: 'maya@harborpine.example',
    });
    const link = emailedConfirmLink((sendEmail.mock.calls[0]![0] as { text: string }).text);
    expect(link).toMatchObject({ type: 'magiclink', next: '/portal', recipient: INVITEE_ID });
  });

  it.each([
    ['no service key to sign with', () => (env.SUPABASE_SERVICE_ROLE_KEY = ''), INVITEE_ID],
    ['a user id that is not a UUID', () => {}, 'auth-user-1'],
  ])(
    'refuses before mapping the person to the customer, and sends nothing, when the link cannot be signed: %s',
    async (_label, arrange, userId) => {
      arrange();
      generateLink.mockResolvedValue({
        data: { properties: { hashed_token: LINK_HASH }, user: { id: userId } },
        error: null,
      });
      const { svc, stub } = makeService();
      await expect(svc.inviteUser('cust-1', 'maya@harborpine.example')).rejects.toMatchObject({
        code: 'internal_error',
      });
      expect(stub.fromCalls).not.toContain('customer_users');
      expect(sendEmail).not.toHaveBeenCalled();
    },
  );

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
    env.SUPABASE_SERVICE_ROLE_KEY = SIGNING_COPY;
    sendEmail.mockResolvedValue({ ok: true, id: 'test' });
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: LINK_HASH }, user: { id: INVITEE_ID } },
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
