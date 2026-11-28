import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import {
  expectOneRefusal,
  HTML_PAGE,
  PNG_WITH_ARCHIVE,
  TINY_PDF,
  TINY_PNG,
} from '@/test/upload-fixtures';
import { makeSupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// Security invariant (part 6, stage 6a): a support screenshot is finalized
// through the one upload check, on the web (submitDashboardTicketAction) and
// on the phone (POST /api/v1/support). Nothing had read its bytes before. A
// refusal removes the object with the service client (members have no delete
// on the bucket), the ticket is not sent, the person reads a plain sentence,
// and exactly one malware / blocked event is recorded in the organization
// with no path. The phone route now checks the same positive SHAPE as the web
// action before anything is read (it had only a prefix check). A clean
// screenshot sends the ticket exactly as before. Tiny made-up files only.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  objects: {} as Record<string, Uint8Array | null>,
  remove: vi.fn(async (_paths: string[]) => ({ data: null, error: null })),
  create: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'ticket-1' })),
}));

const USER = '2f1c9d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const ORG = '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d';
const SHOT = `${USER}/6f1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6071.png`;

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: '9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d',
    userId: '2f1c9d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    email: 'member@example.com',
    fullName: 'Member Example',
  })),
  requireSession: vi.fn(),
}));
vi.mock('@/lib/auth/platform-admin', () => ({ currentUserIsPlatformAdmin: vi.fn(async () => false) }));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: Date.now() })),
}));
vi.mock('@/lib/storage-object-prefix', () => ({
  fetchObjectWindow: vi.fn(async (_bucket: unknown, path: string) => {
    const body = h.objects[path];
    return body ? { prefix: body, totalSize: body.byteLength } : null;
  }),
  fetchObjectWhole: vi.fn(async (_bucket: unknown, path: string) => h.objects[path] ?? null),
}));
// The look for a ticket that already holds this screenshot (part 6): none here.
vi.mock('@/server/services/upload-still-named', () => ({ uploadObjectsStillNamed: vi.fn(async () => false) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ storage: { from: () => ({ remove: h.remove }) } })),
}));
vi.mock('@/server/services/support-tickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/support-tickets')>();
  return { ...actual, createSupportTicket: h.create };
});

import { withApiContext } from '@/lib/auth/api-context';
import { recordSecurityEvent } from '@/server/security/events';
import { submitDashboardTicketAction } from '@/server/actions/support-tickets';
import { POST as phoneSupport } from '@/app/api/v1/support/route';

const record = vi.mocked(recordSecurityEvent);
const BASE = { category: 'bug' as const, subject: 'Broken', message: 'It does not work at all' };

function phoneRequest(attachmentPath: string) {
  return new Request('https://test.local/api/v1/support', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer phone-token' },
    body: JSON.stringify({ ...BASE, attachmentPath }),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(h.objects)) delete h.objects[k];
  record.mockImplementation(async () => undefined);
  const stub = makeSupabaseStub({ 'user_profiles.select': { data: { full_name: 'M' }, error: null } });
  vi.mocked(withApiContext).mockResolvedValue({
    organizationId: ORG,
    userId: USER,
    role: 'staff',
    supabase: stub.client,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(),
  } as never);
});

describe('support screenshot on the web', () => {
  it('a clean screenshot sends the ticket as before, nothing removed or recorded', async () => {
    h.objects[SHOT] = TINY_PNG;
    expect(await submitDashboardTicketAction({ ...BASE, attachmentPath: SHOT })).toEqual({ ok: true });
    expect(h.create.mock.calls[0]![0]).toMatchObject({ attachmentPath: SHOT, organizationId: ORG });
    expect(h.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ['a web page called a screenshot', HTML_PAGE, 'upload_wrong_type'],
    ['a PDF (the bucket takes pictures only)', TINY_PDF, 'upload_wrong_type'],
    ['an archive after the picture', PNG_WITH_ARCHIVE, 'upload_hidden_file'],
  ])('%s: removed, no ticket, a plain sentence, one event', async (_what, body, reason) => {
    h.objects[SHOT] = body;
    const res = await submitDashboardTicketAction({ ...BASE, attachmentPath: SHOT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^[A-Z][^<>{}]+\.$/);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalledWith([SHOT]);
    expectOneRefusal(record, { reason, organizationId: ORG }, [SHOT, USER]);
  });

  it('a screenshot that was never uploaded: no ticket, the sentence, nothing removed or recorded', async () => {
    expect(await submitDashboardTicketAction({ ...BASE, attachmentPath: SHOT })).toEqual({
      ok: false,
      error: 'Your screenshot could not be read. Attach it again and send.',
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a recorder that fails: still removed, still no ticket', async () => {
    record.mockRejectedValue(new Error('recorder down'));
    h.objects[SHOT] = HTML_PAGE;
    expect((await submitDashboardTicketAction({ ...BASE, attachmentPath: SHOT })).ok).toBe(false);
    expect(h.remove).toHaveBeenCalledWith([SHOT]);
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('support screenshot on the phone', () => {
  it('a clean screenshot sends the ticket as before', async () => {
    h.objects[SHOT] = TINY_PNG;
    const res = await phoneSupport(phoneRequest(SHOT));
    expect(res.status).toBe(200);
    expect(h.create.mock.calls[0]![0]).toMatchObject({ attachmentPath: SHOT });
    expect(record).not.toHaveBeenCalled();
  });

  it('a refused screenshot: 400 with the sentence, removed, no ticket, one event from the phone', async () => {
    h.objects[SHOT] = PNG_WITH_ARCHIVE;
    const res = await phoneSupport(phoneRequest(SHOT));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_attachment');
    expect(body.message).toMatch(/^[A-Z][^<>{}]+\.$/);
    expect(h.remove).toHaveBeenCalledWith([SHOT]);
    expect(h.create).not.toHaveBeenCalled();
    expectOneRefusal(record, { reason: 'upload_hidden_file', organizationId: ORG, source: 'phone' }, [SHOT]);
  });

  it.each([
    `${USER}/../../item-images/victim-org/item/cover.jpg`,
    `${USER}/%2e%2e/x.png`,
    `${USER}/x/y.png`,
  ])('NEW here: the key %s is shape-refused before anything is read', async (attachmentPath) => {
    h.objects[attachmentPath] = TINY_PNG;
    const res = await phoneSupport(phoneRequest(attachmentPath));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_attachment');
    expect(h.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
