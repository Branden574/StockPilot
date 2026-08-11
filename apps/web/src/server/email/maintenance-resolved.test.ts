import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Tests for the at-most-once maintenance-resolved email (Task 6). Load-
 * bearing invariants, module-for-module twin of return-prompt.test.ts:
 *
 *   • the `resolution_email_sent_at` marker is claimed via a GUARDED update
 *     (`.is('resolution_email_sent_at', null)`) BEFORE anything is rendered
 *     or sent — only the winner sends;
 *   • every skip guard (row/status/email/self-resolve/marker) is silent —
 *     sendEmail is NEVER called for any of them;
 *   • best-effort: a failing send or a throwing DB read RESOLVES (never
 *     rejects), and the marker stays set after a failed send (at-most-once
 *     — missed email over duplicate, the 0278 posture verbatim);
 *   • proof-photo URLs are minted from the ACTIVE share link's token and
 *     the COMBINED-list indices `listResolutionProofProxyPhotos` returns —
 *     never a locally re-filtered index;
 *   • GC 1: the transport seam is stubbed here, exactly the
 *     return-prompt.test.ts:22-25 pattern — no test in this file can ever
 *     send.
 */

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email/resend', () => ({
  sendEmail: sendEmailMock,
}));

const reportErrorMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: reportErrorMock,
}));

import { maybeSendMaintenanceResolvedEmail } from './maintenance-resolved';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = 'org-test';
const APP_URL = 'https://app.example.com';

const RESOLVED_ROW = {
  id: REQUEST_ID,
  organization_id: ORG_ID,
  status: 'resolved',
  resolved_at: '2026-08-06T21:41:00.000Z',
  resolved_by: 'resolver-1',
  resolved_by_name_snapshot: 'Dana Keeler',
  resolution_note: 'The roof tile has been replaced and the leak is fixed.',
  requester_user_id: 'requester-1',
  requester_email_snapshot: 'reggie@example.com',
  requester_name_snapshot: 'Reggie Requester',
  request_number: 123,
  created_at: '2026-01-01T00:00:00.000Z',
  subject: 'Leaking roof tile in Hall B',
  resolution_email_sent_at: null,
};

/** Org-settings row with the share-link-in-email setting left unconfigured
 *  (defaults ON, same posture as `maintenanceShareLinksEnabled`). */
const MODULE_SETTINGS_DEFAULT = { data: { settings: {} }, error: null };
const NO_ACTIVE_LINK = { data: null, error: null };
/** `.select('id', { count: 'exact', head: true })` shape — no rows, count 0. */
const NO_RESOLUTION_PHOTOS = { data: null, error: null, count: 0 };

/** Stub wired for the happy path; override per test. */
function makeStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'maintenance_requests.select': { data: RESOLVED_ROW, error: null },
    'maintenance_requests.update': { data: { id: REQUEST_ID }, error: null },
    'organizations.select': { data: null, error: null },
    'organization_modules.select': MODULE_SETTINGS_DEFAULT,
    'maintenance_request_share_links.select': NO_ACTIVE_LINK,
    'maintenance_request_attachments.select': NO_RESOLUTION_PHOTOS,
    ...overrides,
  });
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true });
  reportErrorMock.mockClear();
});

describe('maybeSendMaintenanceResolvedEmail', () => {
  it('happy path: resolved row + requester email + null stamp -> the guarded claim is recorded BEFORE sendEmail is called; sendEmail receives the requester, the registry sender, and a "marked resolved" subject', async () => {
    const stub = makeStub();

    // Call-order pin: probe the recorded chain state AT THE MOMENT sendEmail
    // is invoked, so a mutant that moves the guarded claim AFTER the send
    // (T6-M1) is caught even though the FINAL chain state would look
    // identical either way.
    let claimRecordedBeforeSend = false;
    sendEmailMock.mockImplementationOnce(async () => {
      const isArgs = (stub.chainArgs.get('maintenance_requests.update') ?? []).filter(
        (a) => a[0] === 'resolution_email_sent_at',
      );
      claimRecordedBeforeSend = isArgs.some((a) => a[1] === null);
      return { ok: true };
    });

    const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });

    expect(res).toEqual({ sent: true });
    expect(claimRecordedBeforeSend).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const args = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
      from: string;
    };
    expect(args.to).toBe('reggie@example.com');
    expect(args.from).toBe('StockPilot <maintenance@stockpilotusa.com>');
    expect(args.subject).toContain('marked resolved');
    expect(args.subject).toBe('Maintenance request MR-2026-000123 marked resolved');
    // M6 fix wave — closes the last hop of the honesty-line -> template ->
    // transport chain: families/maintenance.test.ts already pins the line
    // into `renderMaintenanceResolvedEmail`'s OWN output, but nothing here
    // proved this SENDER actually forwards that rendered html into the
    // sendEmail() call args untouched. Literal string, copied verbatim —
    // never the imported MAINTENANCE_RESOLVED_HONESTY_LINE constant, which
    // would pass even if the sender silently dropped it and the constant
    // just diffed against itself.
    expect(args.html).toContain(
      'This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation.',
    );

    const updateChain = stub.chains.get('maintenance_requests.update');
    expect(updateChain).toContain('is');
  });

  it('MUTATION GUARD — the guarded claim writes ONLY resolution_email_sent_at, scoped by id, guarded on the column being NULL', async () => {
    const stub = makeStub();
    await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });

    const updateArgs = stub.chainArgs.get('maintenance_requests.update')!;
    const setArg = updateArgs[0]![0] as Record<string, unknown>;
    expect(Object.keys(setArg)).toEqual(['resolution_email_sent_at']);
    expect(updateArgs).toContainEqual(['id', REQUEST_ID]);
    expect(updateArgs).toContainEqual(['resolution_email_sent_at', null]);
  });

  it('resolvedOnDisplay is built HERE via formatOrgDateTime using the ORG timezone, not the template', async () => {
    const stub = makeStub({
      'organizations.select': { data: { timezone: 'America/New_York' }, error: null },
    });
    await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
    const args = sendEmailMock.mock.calls[0]![0] as { html: string };
    // 2026-08-06T21:41:00Z in America/New_York is 5:41 PM EDT.
    expect(args.html).toContain('5:41 PM EDT');
  });

  it('falls back to the default org timezone (America/Los_Angeles) when the org has none set', async () => {
    const stub = makeStub();
    await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
    const args = sendEmailMock.mock.calls[0]![0] as { html: string };
    expect(args.html).toContain('2:41 PM PDT');
  });

  describe('guards (silent skip — sendEmail NEVER called, spy count 0)', () => {
    it('missing row -> request_not_found', async () => {
      const stub = makeStub({ 'maintenance_requests.select': { data: null, error: null } });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'request_not_found' });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    });

    it('status is not resolved (e.g. "saved") -> not_resolved', async () => {
      const stub = makeStub({
        'maintenance_requests.select': { data: { ...RESOLVED_ROW, status: 'saved' }, error: null },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'not_resolved' });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    });

    it('null requester_email_snapshot -> no_requester_email', async () => {
      const stub = makeStub({
        'maintenance_requests.select': {
          data: { ...RESOLVED_ROW, requester_email_snapshot: null },
          error: null,
        },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'no_requester_email' });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    });

    it('resolved_by === requester_user_id (a manage-holder resolving their own request) -> self_resolve', async () => {
      const stub = makeStub({
        'maintenance_requests.select': { data: { ...RESOLVED_ROW, resolved_by: 'requester-1' }, error: null },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'self_resolve' });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    });

    it('a null requester_user_id does NOT trigger self_resolve (nothing to compare resolved_by against) — proceeds normally', async () => {
      const stub = makeStub({
        'maintenance_requests.select': { data: { ...RESOLVED_ROW, requester_user_id: null }, error: null },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: true });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it('resolution_email_sent_at already set (cheap pre-check) -> already_sent, no update even attempted', async () => {
      const stub = makeStub({
        'maintenance_requests.select': {
          data: { ...RESOLVED_ROW, resolution_email_sent_at: '2026-08-06T00:00:00Z' },
          error: null,
        },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'already_sent' });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(stub.chainArgs.has('maintenance_requests.update')).toBe(false);
    });

    it('the guarded update matches no row (lost the race to a concurrent caller) -> lost_race', async () => {
      const stub = makeStub({ 'maintenance_requests.update': { data: null, error: null } });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: false, reason: 'lost_race' });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  it('BEST-EFFORT: send throws -> resolves (never rejects) { sent: false, reason: "send_failed" }; reportError is called; the marker stays set (exactly ONE maintenance_requests.update — no compensating clear)', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('resend down'));
    const stub = makeStub();
    const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'send_failed' });
    expect(reportErrorMock).toHaveBeenCalled();

    const updates = stub.chainArgsAll.get('maintenance_requests.update') ?? [];
    expect(updates).toHaveLength(1);
    // The one update that happened is still the CLAIM (never a clearing
    // update — no second write with resolution_email_sent_at: null).
    const setArg = updates[0]![0]![0] as Record<string, unknown>;
    expect(setArg.resolution_email_sent_at).not.toBeNull();
  });

  describe('proof photos (the ONE ordering funnel — listResolutionProofProxyPhotos / fetchValidAttachments)', () => {
    const TOKEN = 'e'.repeat(64);
    const FUTURE_ISO = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    // 5 rows total, 3 of kind='resolution', deliberately non-contiguous —
    // proves the sender uses COMBINED-list indices (1, 3, 4), never a
    // locally re-filtered resolution-only index (0, 1, 2) — T6-M4.
    const MIXED_ATTACHMENTS = [
      { storage_path: 'org/req/0.jpg', mime_type: 'image/jpeg', safe_filename: 'requester-0.jpg', kind: 'requester' },
      { storage_path: 'org/req/1.jpg', mime_type: 'image/jpeg', safe_filename: 'resolution-1.jpg', kind: 'resolution' },
      { storage_path: 'org/req/2.jpg', mime_type: 'image/jpeg', safe_filename: 'requester-2.jpg', kind: 'requester' },
      { storage_path: 'org/req/3.jpg', mime_type: 'image/jpeg', safe_filename: 'resolution-3.jpg', kind: 'resolution' },
      { storage_path: 'org/req/4.jpg', mime_type: 'image/jpeg', safe_filename: 'resolution-4.jpg', kind: 'resolution' },
    ];

    it('a THREADED share token (mig 0330) that verifies against the live link + 3 kind=resolution rows among 5 total -> proofPhoto srcs are ${appUrl}/m/<token>/photo/<i> at the COMBINED-list indices', async () => {
      const stub = makeStub({
        // The DB now returns only expires_at — the token is the threaded
        // plaintext, never a column read.
        'maintenance_request_share_links.select': { data: { expires_at: FUTURE_ISO }, error: null },
        'maintenance_request_attachments.select': { data: MIXED_ATTACHMENTS, error: null },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, {
        appUrl: APP_URL,
        shareToken: TOKEN,
      });
      expect(res).toEqual({ sent: true });

      const args = sendEmailMock.mock.calls[0]![0] as { html: string };
      expect(args.html).toContain(`src="${APP_URL}/m/${TOKEN}/photo/1"`);
      expect(args.html).toContain(`src="${APP_URL}/m/${TOKEN}/photo/3"`);
      expect(args.html).toContain(`src="${APP_URL}/m/${TOKEN}/photo/4"`);
      // Never the requester-kind rows' own combined indices, and never a
      // re-filtered 0/1/2 (which would collide with index 1 above).
      expect(args.html).not.toContain(`photo/0"`);
      expect(args.html).not.toContain(`photo/2"`);
    });

    it('mig 0330 — NO threaded shareToken -> the share-link table may be probed but no photo URLs are embedded; falls back to the count line; sendEmail still called', async () => {
      const stub = makeStub({
        'maintenance_request_share_links.select': { data: { expires_at: FUTURE_ISO }, error: null },
        'maintenance_request_attachments.select': { data: null, error: null, count: 3 },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: true });
      const args = sendEmailMock.mock.calls[0]![0] as { html: string };
      expect(args.html).not.toMatch(/photo\/\d+"/);
      expect(args.html).toContain('3 proof photos are on the request in StockPilot.');
    });

    it('no active link (none minted, or revoked/expired) -> proofPhotos empty, proofPhotoTotal from the independent resolution-kind count; sendEmail STILL called (photos are not a send precondition)', async () => {
      const stub = makeStub({
        'maintenance_request_share_links.select': { data: null, error: null },
        'maintenance_request_attachments.select': { data: null, error: null, count: 3 },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: true });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);

      const args = sendEmailMock.mock.calls[0]![0] as { html: string };
      expect(args.html).not.toMatch(/photo\/\d+"/);
      expect(args.html).toContain('3 proof photos are on the request in StockPilot.');

      // Pin countResolutionPhotos' three .eq() filters
      const countArgs = stub.chainArgs.get('maintenance_request_attachments.select')!;
      expect(countArgs).toContainEqual(['organization_id', ORG_ID]);
      expect(countArgs).toContainEqual(['maintenance_request_id', REQUEST_ID]);
      expect(countArgs).toContainEqual(['kind', 'resolution']);
    });

    it('org setting includeShareLinksInEmail=false -> proofPhotos empty and the share-link table is never even queried; sendEmail still called', async () => {
      const stub = makeStub({
        'organization_modules.select': { data: { settings: { includeShareLinksInEmail: false } }, error: null },
        'maintenance_request_attachments.select': { data: null, error: null, count: 5 },
      });
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: true });
      expect(stub.chainArgs.has('maintenance_request_share_links.select')).toBe(false);

      const args = sendEmailMock.mock.calls[0]![0] as { html: string };
      expect(args.html).toContain('5 proof photos are on the request in StockPilot.');
    });

    it('no active link and zero resolution photos exist -> proofPhotoTotal 0, no fallback line, sendEmail still called', async () => {
      const stub = makeStub();
      const res = await maybeSendMaintenanceResolvedEmail(stub.client, REQUEST_ID, { appUrl: APP_URL });
      expect(res).toEqual({ sent: true });
      const args = sendEmailMock.mock.calls[0]![0] as { html: string };
      expect(args.html).not.toContain('on the request in StockPilot.');
    });
  });

  it('BEST-EFFORT: a throwing admin read resolves (never rejects) { sent: false, reason: "error" }; sendEmail never called', async () => {
    const client = {
      from: () => {
        throw new Error('db down');
      },
    };
    const res = await maybeSendMaintenanceResolvedEmail(client as never, REQUEST_ID, { appUrl: APP_URL });
    expect(res).toEqual({ sent: false, reason: 'error' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  describe('transport source-scan (GC 2 — sendEmail from @/lib/email/resend is the ONE seam)', () => {
    it('imports @/lib/email/resend exactly once and calls sendEmail( exactly once — no second transport path (direct fetch, Supabase built-in mailer, etc.)', () => {
      const src = readFileSync(path.resolve(__dirname, 'maintenance-resolved.ts'), 'utf8');
      const importMatches = src.match(/from '@\/lib\/email\/resend'/g) ?? [];
      expect(importMatches).toHaveLength(1);
      const callMatches = src.match(/\bsendEmail\(/g) ?? [];
      expect(callMatches).toHaveLength(1);
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('api.resend.com');
      expect(src).not.toContain('.auth.admin');
    });
  });
});
