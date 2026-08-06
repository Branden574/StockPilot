import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Linking from 'expo-linking';

import { prepareMaintenanceEmail } from '@stockpilot/core';

import {
  BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE,
  CONDENSED_NOTICE,
  COPY_HELPER_TEXT,
  DUPLICATE_WARNING,
  OVERSIZED_MESSAGE,
  SUCCESS_MESSAGE,
  openMailtoDraft,
  openMaintenanceDraft,
  openOutlookDraft,
  shouldConfirmBeforeOpening,
  shouldShowCondensedNotice,
} from './maintenance-email-actions';

// expo-linking is a real, already-installed dependency (~7.1.7 —
// apps/mobile/package.json), never a new native module. vi.mock calls are
// hoisted above every import by vitest's transform regardless of their
// textual position (same reasoning maintenance-upload.test.ts documents for
// its own mocks of expo-file-system/expo-image-manipulator) — declared here,
// AFTER the imports above, purely to keep import/first lint-clean, same
// idiom Task 19's fix-wave established for this exact class of warning.
vi.mock('expo-linking', () => ({ openURL: vi.fn(async () => undefined), canOpenURL: vi.fn(async () => true) }));

const PREPARED = prepareMaintenanceEmail({
  requestNumber: 'MR-2026-000123',
  subject: 'AC broken',
  description: 'Warm air.',
  category: null,
  priority: 'high',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: null,
  requesterPhone: null,
  siteName: null,
  department: null,
  building: null,
  roomOrArea: null,
  accessInstructions: null,
  relatedItem: null,
  relatedOrder: null,
  relatedRental: null,
  photoCount: 0,
  shareUrl: null,
});

beforeEach(() => vi.clearAllMocks());

describe('mobile email actions (string assertions ONLY — never a real open in tests)', () => {
  it('outlook action opens the tenant-verified compose URL', async () => {
    await expect(openOutlookDraft(PREPARED)).resolves.toBe('opened');
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=')).toBe(true);
  });

  it('mailto action opens the RFC 6068 URL with the CC intact', async () => {
    await expect(openMailtoDraft(PREPARED)).resolves.toBe('opened');
    const url = vi.mocked(Linking.openURL).mock.calls[0]![0] as string;
    expect(url.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org')).toBe(true);
  });

  it('linkFits=false refuses to open either transport', async () => {
    const oversized = { ...PREPARED, linkFits: false };
    await expect(openOutlookDraft(oversized)).resolves.toBe('blocked');
    await expect(openMailtoDraft(oversized)).resolves.toBe('blocked');
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('an openURL rejection reports blocked instead of throwing', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    await expect(openOutlookDraft(PREPARED)).resolves.toBe('blocked');
  });
});

describe('openMaintenanceDraft — R3 ordering (open first, record ONLY after a real open)', () => {
  it('calls onOpened exactly once, AFTER Linking.openURL resolves, on a successful outlook open', async () => {
    const order: string[] = [];
    vi.mocked(Linking.openURL).mockImplementationOnce(async () => {
      order.push('opened-url');
      return true;
    });
    const onOpened = vi.fn(() => order.push('recorded'));
    await expect(openMaintenanceDraft('outlook', PREPARED, onOpened)).resolves.toBe('opened');
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['opened-url', 'recorded']);
  });

  it('calls onOpened exactly once for a successful mailto open', async () => {
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('mailto', PREPARED, onOpened)).resolves.toBe('opened');
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('never calls onOpened when the open is blocked by an oversized draft', async () => {
    const oversized = { ...PREPARED, linkFits: false };
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('outlook', oversized, onOpened)).resolves.toBe('blocked');
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('never calls onOpened when Linking.openURL rejects (a failed open must not be recorded as opened)', async () => {
    vi.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no handler'));
    const onOpened = vi.fn();
    await expect(openMaintenanceDraft('outlook', PREPARED, onOpened)).resolves.toBe('blocked');
    expect(onOpened).not.toHaveBeenCalled();
  });
});

describe('shouldConfirmBeforeOpening — the duplicate-draft gate (brief section 21)', () => {
  it('never confirms before the first open (openCount 0)', () => {
    expect(shouldConfirmBeforeOpening(0)).toBe(false);
  });

  it('confirms on every reopen (openCount > 0)', () => {
    expect(shouldConfirmBeforeOpening(1)).toBe(true);
    expect(shouldConfirmBeforeOpening(7)).toBe(true);
  });
});

describe('shouldShowCondensedNotice — only when a condensed draft actually opens (never alongside the oversized message)', () => {
  it('true when the draft condensed but still fits', () => {
    expect(shouldShowCondensedNotice({ ...PREPARED, draft: { ...PREPARED.draft, condensed: true }, linkFits: true })).toBe(true);
  });

  it('false when nothing condensed', () => {
    expect(shouldShowCondensedNotice({ ...PREPARED, draft: { ...PREPARED.draft, condensed: false }, linkFits: true })).toBe(false);
  });

  it('false when condensed AND still oversized — the oversized message owns that state, not the condensed notice', () => {
    expect(shouldShowCondensedNotice({ ...PREPARED, draft: { ...PREPARED.draft, condensed: true }, linkFits: false })).toBe(false);
  });
});

describe('exported copy is the literal, brief-pinned text', () => {
  it('SUCCESS_MESSAGE is Task 14 spec line 6, verbatim', () => {
    expect(SUCCESS_MESSAGE).toBe(
      'Outlook opened with your maintenance request. Review the information, attach any downloaded photos you want included directly, and click Send.',
    );
  });

  it('BLOCKED_HEADLINE matches brief section 19, verbatim', () => {
    expect(BLOCKED_HEADLINE).toBe('Outlook could not be opened automatically.');
  });

  it('BLOCKED_RETRY_MESSAGE is the fixed, direction-free wording (fast-follow, 2026-08-06)', () => {
    // Literal pin — this is the fix under test: the string used to read
    // "...or use Copy Email Details below", which was wrong on this screen
    // (the Copy Email Details button renders ABOVE the blocked-state card,
    // not below it). Fixed to drop the directional claim entirely.
    expect(BLOCKED_RETRY_MESSAGE).toBe(
      'Your request is saved — try again, or use Copy Email Details instead.',
    );
    // Belt-and-suspenders: no layout-direction word can sneak back in,
    // regardless of the exact phrasing chosen.
    expect(BLOCKED_RETRY_MESSAGE.toLowerCase()).not.toContain('below');
    expect(BLOCKED_RETRY_MESSAGE.toLowerCase()).not.toContain('above');
  });

  it('DUPLICATE_WARNING matches brief section 21, verbatim', () => {
    expect(DUPLICATE_WARNING).toBe(
      'A maintenance email draft was already opened for this request. Sending multiple copies may create duplicate Zendesk tickets.',
    );
  });

  it('OVERSIZED_MESSAGE never claims the link could open', () => {
    expect(OVERSIZED_MESSAGE).toContain('Copy Email Details');
    expect(OVERSIZED_MESSAGE.toLowerCase()).not.toContain('outlook opened');
  });

  it('CONDENSED_NOTICE discloses the shortening and points at Copy Email Details for the full text', () => {
    expect(CONDENSED_NOTICE).toBe(
      'This email will open with a shortened summary — the full request was too long for a compose link. The complete details are saved in this request, and Copy Email Details always includes everything.',
    );
  });

  it('COPY_HELPER_TEXT is the exact press-and-hold instruction (audit Q9 — no clipboard module, this IS the affordance)', () => {
    expect(COPY_HELPER_TEXT).toBe('Press and hold inside the box to select and copy.');
  });

  it('none of the exported copy uses forbidden outcome vocabulary (brief section 20)', () => {
    const FORBIDDEN = [
      'Ticket created',
      'Request submitted to Zendesk',
      'DC4 notified',
      'Andrew notified',
      'Ticket assigned',
      'Email sent',
    ];
    for (const text of [
      SUCCESS_MESSAGE,
      BLOCKED_HEADLINE,
      BLOCKED_RETRY_MESSAGE,
      DUPLICATE_WARNING,
      OVERSIZED_MESSAGE,
      CONDENSED_NOTICE,
      COPY_HELPER_TEXT,
    ]) {
      for (const banned of FORBIDDEN) {
        expect(text).not.toContain(banned);
      }
    }
  });
});
