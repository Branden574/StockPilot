import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for SP-142 — the support-ticket `attachmentPath` gate.
 *
 * The action used to accept any string that merely STARTED WITH
 * `${ctx.userId}/`. That is the HI-8 negative-prefix shape documented at
 * length in `lib/storage-path.ts`: a prefix check says nothing about the rest
 * of the string, so `${uid}/../../item-images/<victim-org>/<item>/cover.jpg`
 * passed it and was persisted verbatim onto the ticket row, later to be handed
 * to the SERVICE-ROLE storage client. These tests pin the positive-shape gate
 * that replaced it.
 */

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const USER_ID = '2f1c9d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const ORG_ID = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d';

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: ORG_ID,
    userId: USER_ID,
    email: 'member@example.com',
    fullName: 'Member Example',
  })),
  requireSession: vi.fn(async () => ({ user: { id: USER_ID } })),
}));
vi.mock('@/lib/auth/platform-admin', () => ({
  currentUserIsPlatformAdmin: vi.fn(async () => false),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: Date.now() })),
}));

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'ticket-1' })),
}));
vi.mock('@/server/services/support-tickets', () => ({
  TICKET_CATEGORIES: ['bug', 'billing', 'account', 'feature', 'other'] as const,
  TICKET_PRIORITIES: ['low', 'normal', 'high', 'urgent'] as const,
  TICKET_STATUSES: ['open', 'in_progress', 'resolved', 'closed'] as const,
  createSupportTicket: (input: Record<string, unknown>) => mockCreate(input),
  updateSupportTicket: vi.fn(async () => {}),
}));

import { submitDashboardTicketAction } from './support-tickets';

const BASE = {
  category: 'bug' as const,
  subject: 'Broken',
  message: 'It does not work at all',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitDashboardTicketAction — attachmentPath is shape-validated, not prefix-checked', () => {
  it.each([
    // The HI-8 payload: passes `startsWith(`${uid}/`)`, escapes the folder AND
    // the bucket once any storage client normalises the `..` segments.
    ['dot-dot traversal', `${USER_ID}/../../item-images/victim-org/item/cover.jpg`],
    // Percent-encoded traversal — decoded downstream, invisible to startsWith.
    ['percent-encoded traversal', `${USER_ID}/%2e%2e/x.png`],
    // Extra folder depth: not a shape this product ever mints, so it can only
    // be hand-crafted.
    ['extra path segment', `${USER_ID}/x/y.png`],
    // Absolute path — resolves off the bucket root.
    ['leading slash escape', `${USER_ID}//etc/passwd.png`],
    // Prefix-collision: another uid that merely starts with ours.
    ['uid prefix collision', `${USER_ID}x/shot.png`],
    // Backslash separator (Windows-style) — normalised by some clients.
    ['backslash separator', `${USER_ID}/..\\shot.png`],
  ])('refuses %s without ever calling the service', async (_label, attachmentPath) => {
    const res = await submitDashboardTicketAction({ ...BASE, attachmentPath });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Invalid attachment/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    // The web mint: support-ticket-form.tsx `${userId}/${crypto.randomUUID()}.${ext}`.
    ['web uuid mint', `${USER_ID}/6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071.png`],
    // The mobile mint: support.tsx `${user.id}/${base36x12}.${ext}`.
    ['mobile base36 mint', `${USER_ID}/k3j9x2mq7z1a.jpg`],
  ])('still accepts the real %s', async (_label, attachmentPath) => {
    const res = await submitDashboardTicketAction({ ...BASE, attachmentPath });

    expect(res.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ attachmentPath });
  });

  it('accepts a ticket with no attachment at all', async () => {
    const res = await submitDashboardTicketAction(BASE);

    expect(res.ok).toBe(true);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ attachmentPath: null });
  });
});
