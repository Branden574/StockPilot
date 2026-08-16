import { describe, expect, it } from 'vitest';

import {
  L4L_MAINTENANCE_EMAIL,
  L4L_MAINTENANCE_EMAIL_NAMES,
  MAINTENANCE_CC_NOTICE,
  maintenanceCcNotice,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUS_LABELS,
  MAINTENANCE_MAX_PHOTOS,
  MAINTENANCE_MAX_PHOTO_BYTES,
  MAINTENANCE_SHARE_LINK_TTL_DAYS,
  MAINTENANCE_ATTACHMENT_KINDS,
  MAINTENANCE_RESOLUTION_NOTE_MAX,
} from './constants';

/**
 * The recipient pair is an operational constant, not configuration — getting
 * either address wrong sends a maintenance issue to the wrong mailbox
 * silently. Same posture as apps/web/src/lib/site.ts's DELIVERY_REQUEST_EMAIL
 * pins: literal strings, never the same constant reflected back at itself.
 */
describe('maintenance recipient constants', () => {
  it('pins the exact addresses (LITERALS — Global Constraint 19)', () => {
    expect(L4L_MAINTENANCE_EMAIL.to).toBe('dc4@learn4life.org');
    expect(L4L_MAINTENANCE_EMAIL.cc).toBe('arosas@cvwest.org');
    expect(Object.isFrozen(L4L_MAINTENANCE_EMAIL)).toBe(true);
  });

  it('has exactly two recipient keys — no third address sneaks in', () => {
    expect(Object.keys(L4L_MAINTENANCE_EMAIL).sort()).toEqual(['cc', 'to']);
  });

  it('never concatenates the two addresses into one field', () => {
    expect(L4L_MAINTENANCE_EMAIL.to).not.toContain(',');
    expect(L4L_MAINTENANCE_EMAIL.to).not.toContain(';');
    expect(L4L_MAINTENANCE_EMAIL.to).not.toContain(L4L_MAINTENANCE_EMAIL.cc);
    expect(L4L_MAINTENANCE_EMAIL.cc).not.toContain(',');
    expect(L4L_MAINTENANCE_EMAIL.cc).not.toContain(';');
  });

  it('is frozen at runtime, so no caller can mutate the shared object', () => {
    expect(Object.isFrozen(L4L_MAINTENANCE_EMAIL)).toBe(true);
    expect(() => {
      (L4L_MAINTENANCE_EMAIL as unknown as Record<string, string>).cc = 'attacker@evil.test';
    }).toThrow();
    expect(L4L_MAINTENANCE_EMAIL.cc).toBe('arosas@cvwest.org');
  });

  it('display names are free of RFC 5322 specials', () => {
    for (const name of Object.values(L4L_MAINTENANCE_EMAIL_NAMES)) {
      expect(name).not.toMatch(/[<>,"@;]/);
    }
    expect(Object.isFrozen(L4L_MAINTENANCE_EMAIL_NAMES)).toBe(true);
  });

  it('pins the exact tenant-verified display-name pair', () => {
    expect(L4L_MAINTENANCE_EMAIL_NAMES.to).toBe('Fresno Warehouse DC4');
    expect(L4L_MAINTENANCE_EMAIL_NAMES.cc).toBe('Andrew Rosas');
  });

  it('display names never contain an address — names and addresses stay separate constants', () => {
    expect(L4L_MAINTENANCE_EMAIL_NAMES.to).not.toContain('@');
    expect(L4L_MAINTENANCE_EMAIL_NAMES.cc).not.toContain('@');
  });

  it('is frozen at runtime for the display names too', () => {
    expect(() => {
      (L4L_MAINTENANCE_EMAIL_NAMES as unknown as Record<string, string>).cc = 'Someone Else';
    }).toThrow();
    expect(L4L_MAINTENANCE_EMAIL_NAMES.cc).toBe('Andrew Rosas');
  });

  it('CC notice promises only what StockPilot can observe', () => {
    // REWORDED 2026-08-16 (per-org email routing): the previous "The DC4
    // address creates the maintenance ticket in the email system" sentence
    // was L4L-Zendesk-specific knowledge the platform cannot truthfully
    // claim for an arbitrary org's configured mailbox, so the notice is now
    // a pure function of the recipients (`maintenanceCcNotice`) claiming
    // only where the mail is addressed — L4L's screens deliberately lose
    // that one sentence.
    expect(MAINTENANCE_CC_NOTICE).toBe(
      'This request will be emailed to dc4@learn4life.org. A copy will also be sent to arosas@cvwest.org.',
    );
    for (const banned of ['assigned', 'Ticket created', 'notified', 'ticket']) {
      expect(MAINTENANCE_CC_NOTICE).not.toContain(banned);
    }
  });

  /**
   * The notice used to hand-type the CC address a second time, which made this
   * sentence a silent SECOND definition of where the copy goes: changing
   * L4L_MAINTENANCE_EMAIL.cc would have left every screen showing this notice
   * naming the old mailbox while the mail went to the new one — telling the
   * requester in writing that a copy was sent somewhere it was not.
   *
   * Still pinned by MUTATION of the address rather than of the sentence —
   * now through the notice FUNCTION: both addresses appear by interpolation,
   * in to-then-cc order, and each is labelled by its role, so a hand-typed
   * copy that stops following the constants fails here.
   */
  it('names BOTH recipients by INTERPOLATION — to then cc, nothing else', () => {
    expect(MAINTENANCE_CC_NOTICE.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)).toEqual([
      L4L_MAINTENANCE_EMAIL.to,
      L4L_MAINTENANCE_EMAIL.cc,
    ]);
  });

  it('maintenanceCcNotice follows ANY recipients it is handed (the per-org path)', () => {
    const notice = maintenanceCcNotice({
      to: 'intake@other-tenant.invalid',
      cc: 'copy@other-tenant.invalid',
    });
    expect(notice).toBe(
      'This request will be emailed to intake@other-tenant.invalid. A copy will also be sent to copy@other-tenant.invalid.',
    );
    // A notice hand-wired to the constants would name L4L here.
    expect(notice).not.toContain('learn4life');
    expect(notice).not.toContain('cvwest');
  });
});

describe('status labels — the ONLY five states (Maintenance Resolved spec §1.1/§11)', () => {
  it('pins the exact display strings', () => {
    expect(MAINTENANCE_STATUS_LABELS).toEqual({
      saved: 'Saved',
      draft_opened: 'Email draft opened',
      resolved: 'Resolved',
      archived: 'Archived',
      cancelled: 'Cancelled',
    });
  });

  it('pins insertion order — resolved lands BETWEEN draft_opened and archived (spec §1.1: the web pill order and STATUS_VALUES both derive from this key order)', () => {
    expect(Object.keys(MAINTENANCE_STATUS_LABELS)).toEqual([
      'saved',
      'draft_opened',
      'resolved',
      'archived',
      'cancelled',
    ]);
  });

  it('never uses the forbidden confirmation vocabulary (Global Constraint 8, extended by GC 4/spec §11)', () => {
    const all = Object.values(MAINTENANCE_STATUS_LABELS).join(' | ');
    for (const banned of [
      'Ticket created',
      'Request submitted to Zendesk',
      'DC4 notified',
      'Andrew notified',
      'Ticket assigned',
      'Email sent',
      'Ticket closed',
      'Ticket resolved',
      'Zendesk ticket closed',
      'Zendesk ticket updated',
      'Zendesk ticket resolved',
      'Issue verified fixed',
    ]) {
      expect(all).not.toContain(banned);
    }
  });

  it('has exactly five states — no sixth status sneaks in', () => {
    expect(Object.keys(MAINTENANCE_STATUS_LABELS).sort()).toEqual([
      'archived',
      'cancelled',
      'draft_opened',
      'resolved',
      'saved',
    ]);
  });
});

describe('attachment kinds (migration 0317, spec §2.2/§3.1)', () => {
  it('pins the exact two kind literals, in order', () => {
    expect(MAINTENANCE_ATTACHMENT_KINDS).toEqual(['requester', 'resolution']);
  });

  it('pins the resolution note cap', () => {
    expect(MAINTENANCE_RESOLUTION_NOTE_MAX).toBe(2000);
  });
});

describe('form option constants', () => {
  it('the twelve Brief section-7 categories, in order', () => {
    expect(MAINTENANCE_CATEGORIES).toEqual([
      'Facilities',
      'Electrical',
      'Plumbing',
      'Heating or air conditioning',
      'Technology',
      'Furniture',
      'Vehicle',
      'Security',
      'Safety',
      'Cleaning',
      'Inventory or equipment',
      'Other',
    ]);
    expect(MAINTENANCE_CATEGORIES).toHaveLength(12);
  });

  it('priorities and caps', () => {
    expect(MAINTENANCE_PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
    expect(MAINTENANCE_MAX_PHOTOS).toBe(8);
    expect(MAINTENANCE_MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
    expect(MAINTENANCE_SHARE_LINK_TTL_DAYS).toBe(180);
  });

  it('pins the literal byte cap independent of the multiplication (10 MiB)', () => {
    expect(MAINTENANCE_MAX_PHOTO_BYTES).toBe(10_485_760);
  });
});
