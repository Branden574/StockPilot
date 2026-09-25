import { isBorrowerEmailFormat } from '@stockpilot/core';

import { api, ApiError } from './api';

/**
 * The phone's New rental borrower: a team member found by search, or anyone
 * else by typed name (and email, if they have one). The twin of the web
 * BorrowerPicker (apps/web/src/components/rentals/borrower-picker.tsx), which
 * the owner found hard to use for non-members (2026-09-25); the phone had no
 * member search at all, so every phone rental was a typed name, and a team
 * member typed by hand got no borrower_user_id and no account email.
 *
 * WHERE THE MEMBERS COME FROM: GET /api/v1/rentals/borrowers, the same query
 * that fills the web picker (RentalsService.listBorrowerMembers), gated on
 * rentals:create and read with the caller's own session, so the phone shows
 * no member or email the web would not.
 *
 * THE RULES (the web picker's): picking a member sets their user id, their
 * name and THEIR account email; typing over a picked member makes the
 * borrower someone else and drops the member's email with it, so a member's
 * address never rides along on another person's rental; "Someone not in
 * StockPilot" starts a fresh typed borrower.
 *
 * OFFLINE: the member search needs a connection, and says so when it cannot
 * load. The typed name and email still fill in, but this screen has never
 * worked offline as a whole: its warehouse and item lists are live reads and
 * Check out is a live POST (no outbox), so an offline checkout fails with the
 * server's reason either way.
 */

export interface RentalBorrowerMember {
  userId: string;
  displayName: string;
  email: string | null;
}

/** The borrower as the form holds it. `userId` is set only for a picked member. */
export interface BorrowerDraft {
  userId: string | null;
  name: string;
  email: string;
}

export const EMPTY_BORROWER: BorrowerDraft = { userId: null, name: '', email: '' };

/** Suggestions shown under the name while typing. */
export const BORROWER_SUGGESTION_LIMIT = 6;

/** Said after any reason the member search is unavailable. */
export const BORROWER_TYPE_ANYONE_NOTE = 'You can still type anyone’s name and email.';

export const BORROWER_SEARCH_OFFLINE_NOTE = `Team member search needs a connection. ${BORROWER_TYPE_ANYONE_NOTE}`;

export const BORROWER_EMAIL_FORMAT_ERROR =
  'Enter a full email address, like name@example.com, or leave it blank.';

function isMemberRow(value: unknown): value is RentalBorrowerMember {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' &&
    v.userId.length > 0 &&
    typeof v.displayName === 'string' &&
    (v.email === null || typeof v.email === 'string')
  );
}

/** The team members a rental can go to (rentals:create; 403 otherwise). */
export async function listRentalBorrowers(): Promise<RentalBorrowerMember[]> {
  const res = await api<{ members?: unknown }>('/api/v1/rentals/borrowers');
  const rows = Array.isArray(res?.members) ? res.members : [];
  return rows.filter(isMemberRow);
}

export type BorrowerSearch =
  | { status: 'loading' }
  | { status: 'ready'; members: RentalBorrowerMember[] }
  | { status: 'failed'; message: string };

/**
 * What a failed load says. The server answered: its own sentence (api() never
 * lets raw markup or database text through). No answer at all (offline, a
 * timeout): the search needs a connection. Either way, typing still works.
 */
export function borrowerSearchFailure(error: unknown): BorrowerSearch {
  if (error instanceof ApiError) {
    const reason = error.message.trim() || 'Could not load team members.';
    return { status: 'failed', message: `${reason} ${BORROWER_TYPE_ANYONE_NOTE}` };
  }
  return { status: 'failed', message: BORROWER_SEARCH_OFFLINE_NOTE };
}

/** A team member was chosen: their id, their name, their account email. */
export function pickMember(member: RentalBorrowerMember): BorrowerDraft {
  return { userId: member.userId, name: member.displayName, email: member.email ?? '' };
}

/** "Someone not in StockPilot": a fresh borrower, never a member's email. */
export function someoneElse(draft: BorrowerDraft): BorrowerDraft {
  return draft.userId ? { ...EMPTY_BORROWER } : draft;
}

/**
 * After the member list (re)loads: a picked member who is not on it (another
 * organization's, after a switch) is dropped, with their email, rather than
 * sent to create_rental, which would refuse them.
 */
export function keepPickedMember(
  draft: BorrowerDraft,
  members: readonly RentalBorrowerMember[],
): BorrowerDraft {
  if (!draft.userId) return draft;
  return members.some((m) => m.userId === draft.userId) ? draft : { ...EMPTY_BORROWER };
}

/** Typing the name. Over a picked member, the borrower becomes someone else. */
export function typeName(draft: BorrowerDraft, name: string): BorrowerDraft {
  if (draft.userId) return { userId: null, name, email: '' };
  return { ...draft, name };
}

/** Typing the email (shown only for someone not in StockPilot). */
export function typeEmail(draft: BorrowerDraft, email: string): BorrowerDraft {
  return { ...draft, userId: null, email };
}

/**
 * The members matching what was typed (name or email, any case), at most
 * `limit`, and how many more matched. Nothing before anything is typed, and
 * nothing while a member is picked.
 */
export function matchBorrowers(
  members: readonly RentalBorrowerMember[],
  draft: BorrowerDraft,
  limit: number = BORROWER_SUGGESTION_LIMIT,
): { shown: RentalBorrowerMember[]; more: number } {
  const needle = draft.name.trim().toLowerCase();
  if (draft.userId || !needle) return { shown: [], more: 0 };
  const hits = members.filter(
    (m) =>
      m.displayName.toLowerCase().includes(needle) ||
      (m.email?.toLowerCase().includes(needle) ?? false),
  );
  return { shown: hits.slice(0, limit), more: Math.max(0, hits.length - limit) };
}

/** A typed email that is present but not an address (the web form's check). */
export function borrowerEmailInvalid(draft: BorrowerDraft): boolean {
  const email = draft.email.trim();
  return draft.userId === null && email.length > 0 && !isBorrowerEmailFormat(email);
}

/** The borrower fields of the POST /api/v1/rentals body. */
export function borrowerRequestFields(draft: BorrowerDraft): {
  borrowerUserId: string | null;
  borrowerName: string;
  borrowerEmail: string | null;
} {
  return {
    borrowerUserId: draft.userId,
    borrowerName: draft.name.trim(),
    borrowerEmail: draft.email.trim() || null,
  };
}
