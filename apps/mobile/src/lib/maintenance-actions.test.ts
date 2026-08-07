import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_BUTTON_LABEL,
  ARCHIVE_CANCEL_LABEL,
  ARCHIVE_CONFIRM_MESSAGE,
  ARCHIVE_CONFIRM_TITLE,
  ARCHIVE_GENERIC_ERROR,
  ASSIGN_OWNER_GENERIC_ERROR,
  ASSIGN_OWNER_HELPER,
  ASSIGN_OWNER_SECTION_LABEL,
  ASSIGN_OWNER_TOGGLE_LABEL,
  ASSIGN_OWNER_UNASSIGNED_LABEL,
  MEMBERS_LOAD_ERROR,
  MOBILE_RESOLVE_DISCLOSURE,
  NOTES_ADD_GENERIC_ERROR,
  NOTES_ADD_LABEL,
  NOTES_ADD_PENDING_LABEL,
  NOTES_EMPTY,
  NOTES_HELPER,
  NOTES_LOAD_ERROR,
  NOTES_PLACEHOLDER,
  NOTES_SECTION_LABEL,
  NOTES_TOGGLE_LABEL,
  NOTES_TRUNCATED,
  NOTES_UNKNOWN_AUTHOR_LABEL,
  RESOLVE_ADD_PHOTO_LABEL,
  RESOLVE_CONFIRM_LABEL,
  RESOLVE_GENERIC_ERROR,
  RESOLVE_NOTE_PLACEHOLDER,
  RESOLVE_PENDING_LABEL,
  RESOLVE_TOGGLE_LABEL,
  availableCloseoutActions,
  canConfirmResolve,
  mapActionError,
  resolveNoteAuthorName,
  resolveNoteHelperText,
} from './maintenance-actions';

describe('availableCloseoutActions', () => {
  it('open + manage: all true except cancelNote (a manager viewing a request they did not submit)', () => {
    expect(
      availableCloseoutActions({
        canManage: true,
        isOwnRequest: false,
        archivedAt: null,
        cancelledAt: null,
        resolvedAt: null,
      }),
    ).toEqual({ resolve: true, archive: true, cancelNote: false, assignOwner: true, notes: true });
  });

  it('resolved + manage: resolve/assignOwner close, archive/notes stay open', () => {
    expect(
      availableCloseoutActions({
        canManage: true,
        isOwnRequest: false,
        archivedAt: null,
        cancelledAt: null,
        resolvedAt: '2026-08-05T00:00:00.000Z',
      }),
    ).toEqual({
      resolve: false,
      archive: true,
      cancelNote: false,
      assignOwner: false,
      notes: true,
    });
  });

  it('cancelled + manage: archive stays available, resolve does not', () => {
    const result = availableCloseoutActions({
      canManage: true,
      isOwnRequest: false,
      archivedAt: null,
      cancelledAt: '2026-08-05T00:00:00.000Z',
      resolvedAt: null,
    });
    expect(result.archive).toBe(true);
    expect(result.resolve).toBe(false);
    // Full shape too — cancelled is "closed" the same way resolved is.
    expect(result).toEqual({
      resolve: false,
      archive: true,
      cancelNote: false,
      assignOwner: false,
      notes: true,
    });
  });

  it('archived + manage: all false except notes (D1 — archive of an already-archived row makes no sense)', () => {
    expect(
      availableCloseoutActions({
        canManage: true,
        isOwnRequest: false,
        archivedAt: '2026-08-05T00:00:00.000Z',
        cancelledAt: null,
        resolvedAt: null,
      }),
    ).toEqual({
      resolve: false,
      archive: false,
      cancelNote: false,
      assignOwner: false,
      notes: true,
    });
  });

  it('open + not-manage: all false (cancel remains the shipped web requester flow; mobile has no Cancel UI at all yet)', () => {
    expect(
      availableCloseoutActions({
        canManage: false,
        isOwnRequest: false,
        archivedAt: null,
        cancelledAt: null,
        resolvedAt: null,
      }),
    ).toEqual({
      resolve: false,
      archive: false,
      cancelNote: false,
      assignOwner: false,
      notes: false,
    });
  });

  it('cancelNote genuinely reads isOwnRequest (not hardcoded false) — an open row, no manage, but the caller IS the requester', () => {
    // Not one of the brief's required literal cases, but proves cancelNote
    // is a real computed field (mirroring web's showCancel), not dead
    // weight that always returns false regardless of input.
    expect(
      availableCloseoutActions({
        canManage: false,
        isOwnRequest: true,
        archivedAt: null,
        cancelledAt: null,
        resolvedAt: null,
      }).cancelNote,
    ).toBe(true);
  });

  it('cancelNote closes the same way resolve/assignOwner do — a resolved row the requester owns', () => {
    expect(
      availableCloseoutActions({
        canManage: false,
        isOwnRequest: true,
        archivedAt: null,
        cancelledAt: null,
        resolvedAt: '2026-08-05T00:00:00.000Z',
      }).cancelNote,
    ).toBe(false);
  });
});

describe('canConfirmResolve', () => {
  it('rejects whitespace-only input', () => {
    expect(canConfirmResolve('    ')).toBe(false);
  });

  it('accepts exactly 5 trimmed characters (the schema min)', () => {
    expect(canConfirmResolve('Fixed')).toBe(true);
  });

  it('rejects 4 trimmed characters — one under the min', () => {
    expect(canConfirmResolve('Fixd')).toBe(false);
  });

  it('trims surrounding whitespace before measuring length', () => {
    expect(canConfirmResolve('  Fixed  ')).toBe(true);
    expect(canConfirmResolve('   Fix   ')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(canConfirmResolve('')).toBe(false);
  });
});

describe('resolveNoteHelperText', () => {
  it('renders the shared 2000-char cap literally, matching MAINTENANCE_RESOLUTION_NOTE_MAX', () => {
    expect(resolveNoteHelperText()).toBe('Required. 2000 characters max.');
  });
});

describe('resolveNoteAuthorName', () => {
  const members = [
    { userId: 'u-1', name: 'Dana Keeler' },
    { userId: 'u-2', name: 'Andrew Rosas' },
  ];

  it('resolves a known author to their display name', () => {
    expect(resolveNoteAuthorName('u-1', members)).toBe('Dana Keeler');
  });

  it('falls back to the generic label for an author not in the roster (a removed member)', () => {
    expect(resolveNoteAuthorName('u-9', members)).toBe(NOTES_UNKNOWN_AUTHOR_LABEL);
  });

  it('falls back to the generic label for a null authorUserId', () => {
    expect(resolveNoteAuthorName(null, members)).toBe(NOTES_UNKNOWN_AUTHOR_LABEL);
  });

  it('falls back to the generic label against an empty roster', () => {
    expect(resolveNoteAuthorName('u-1', [])).toBe(NOTES_UNKNOWN_AUTHOR_LABEL);
  });
});

describe('mapActionError', () => {
  it('forwards a real Error message verbatim (the server\'s own reason)', () => {
    expect(mapActionError(new Error('This request is already resolved.'), 'fallback')).toBe(
      'This request is already resolved.',
    );
  });

  it('falls back for a non-Error throw (e.g. a bare string rejection)', () => {
    expect(mapActionError('boom', 'fallback')).toBe('fallback');
  });

  it('falls back for an Error with an empty/whitespace-only message', () => {
    expect(mapActionError(new Error('   '), 'fallback')).toBe('fallback');
  });

  it('falls back for undefined/null', () => {
    expect(mapActionError(undefined, 'fallback')).toBe('fallback');
    expect(mapActionError(null, 'fallback')).toBe('fallback');
  });
});

describe('MOBILE_RESOLVE_DISCLOSURE', () => {
  it('is pinned verbatim (mirrors the web ResolveRequestDialog disclosure, generic "the requester")', () => {
    expect(MOBILE_RESOLVE_DISCLOSURE).toBe(
      'Marks this request resolved in StockPilot and emails the requester the note and any proof photos. It does not close or update the Zendesk ticket.',
    );
  });
});

/**
 * §GC-4 forbidden-vocabulary sweep, extended for Maintenance Resolved
 * (docs/superpowers/plans/2026-08-06-maintenance-resolved.md Global
 * Constraint 4) — every exported plain-string copy constant in this
 * module, checked against the FULL forbidden list (the original six T18-20
 * entries plus the six new resolved-specific ones). A mutation that rewords
 * MOBILE_RESOLVE_DISCLOSURE to claim the Zendesk ticket closes, or any
 * other constant here to claim an outcome StockPilot cannot observe, fails
 * this test.
 */
describe('exported copy — forbidden vocabulary sweep (§GC-4)', () => {
  const FORBIDDEN = [
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
    // Present-tense variant of 'Ticket closed'/'Zendesk ticket closed' —
    // task-10-brief.md's own T10-M4 mutation ("reworded to 'and closes the
    // ticket'") is written in THIS tense, so the sweep must catch it too,
    // not just the literal pin on MOBILE_RESOLVE_DISCLOSURE.
    'closes the ticket',
  ];

  const ALL_COPY = [
    MOBILE_RESOLVE_DISCLOSURE,
    resolveNoteHelperText(),
    RESOLVE_NOTE_PLACEHOLDER,
    RESOLVE_TOGGLE_LABEL,
    RESOLVE_ADD_PHOTO_LABEL,
    RESOLVE_CONFIRM_LABEL,
    RESOLVE_PENDING_LABEL,
    RESOLVE_GENERIC_ERROR,
    ARCHIVE_BUTTON_LABEL,
    ARCHIVE_CONFIRM_TITLE,
    ARCHIVE_CONFIRM_MESSAGE,
    ARCHIVE_CANCEL_LABEL,
    ARCHIVE_GENERIC_ERROR,
    ASSIGN_OWNER_TOGGLE_LABEL,
    ASSIGN_OWNER_SECTION_LABEL,
    ASSIGN_OWNER_HELPER,
    ASSIGN_OWNER_UNASSIGNED_LABEL,
    ASSIGN_OWNER_GENERIC_ERROR,
    MEMBERS_LOAD_ERROR,
    NOTES_TOGGLE_LABEL,
    NOTES_SECTION_LABEL,
    NOTES_HELPER,
    NOTES_EMPTY,
    NOTES_PLACEHOLDER,
    NOTES_ADD_LABEL,
    NOTES_ADD_PENDING_LABEL,
    NOTES_TRUNCATED,
    NOTES_UNKNOWN_AUTHOR_LABEL,
    NOTES_ADD_GENERIC_ERROR,
    NOTES_LOAD_ERROR,
  ];

  it('sweeps every exported copy constant against the full forbidden list', () => {
    for (const text of ALL_COPY) {
      for (const banned of FORBIDDEN) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it('the sweep set itself is non-empty (a mutation that empties ALL_COPY must not silently pass)', () => {
    expect(ALL_COPY.length).toBeGreaterThan(20);
  });
});
