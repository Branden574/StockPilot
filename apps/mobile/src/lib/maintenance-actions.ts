import { MAINTENANCE_RESOLUTION_NOTE_MAX } from '@stockpilot/core';

/**
 * Pure decision helpers behind the maintenance detail screen's CLOSE-OUT
 * card (Task 10: Resolve with note + proof, Archive, Assign owner, Internal
 * notes). Same "source-pin honesty" posture maintenance-filters.ts (Task 9)
 * and maintenance-email-actions.ts (Tasks 18-20) established: this repo's
 * vitest cannot render app/ screens (native imports at module load — see
 * vitest.config.ts), so every DECISION the CLOSE-OUT card makes is
 * delegated to a function below and gets a real behavioral test here,
 * rather than only a source-text pin on app/maintenance/[id].tsx that can
 * never prove the logic actually RUNS correctly at runtime.
 */

export interface CloseoutActionAvailability {
  /** Manage-only, open rows only. Mirrors web page.tsx's `showResolve`
   *  (`canManage && !closed`, `closed = archivedAt || cancelledAt ||
   *  resolvedAt`). */
  resolve: boolean;
  /** Manage-only, non-archived rows — INCLUDING resolved/cancelled (owner
   *  decision D1: archive is a re-bucket, not a second closed state).
   *  Mirrors web's `showArchive` (`canManage && !archivedAt`) exactly. */
  archive: boolean;
  /** The shipped web requester-Cancel flow's own gate (`isOwningRequester
   *  && !closed`, page.tsx's `showCancel`), computed here for signature
   *  completeness only. Mobile has NO Cancel affordance at all yet (there
   *  is no cancelMaintenanceRequest* wrapper anywhere in this app) — the
   *  Task 10 CLOSE-OUT card never reads this field and renders nothing for
   *  it. Out of THIS task's scope per the brief ("the requester's own
   *  Cancel is NOT in this task's scope unless the brief says so");
   *  computed correctly anyway so a future task that DOES add a mobile
   *  Cancel card can consume this matrix without redoing it. */
  cancelNote: boolean;
  /** Manage-only AND the row must still be open. Deliberately STRICTER
   *  than web's AssignOwnerSelect, which renders for any canManage viewer
   *  regardless of closed state (assignLocalOwner() has no closed guard
   *  server-side either) — this is a documented mobile-specific
   *  restriction (task-10-brief.md Step 1's truth table is the authority
   *  for it), not a bug to "fix" to match web without re-reading that
   *  brief first. */
  assignOwner: boolean;
  /** Manage-only, in EVERY lifecycle state. Mirrors web's bare `canManage`
   *  gate on MaintenanceNotesPanel — internal coordination notes stay
   *  readable/writable on an archived or resolved row, since coordination
   *  doesn't stop the moment a request closes. */
  notes: boolean;
}

/**
 * Action-visibility matrix for the CLOSE-OUT card (task-10-brief.md Step
 * 1's truth table is the literal source of the five cases this function is
 * tested against). `closed` is the ONE fact that governs resolve/
 * cancelNote/assignOwner identically — archive alone uses the narrower
 * `!archivedAt` test (D1), and notes uses no lifecycle test at all.
 */
export function availableCloseoutActions(d: {
  canManage: boolean;
  isOwnRequest: boolean;
  archivedAt: string | null;
  cancelledAt: string | null;
  resolvedAt: string | null;
}): CloseoutActionAvailability {
  const closed = Boolean(d.archivedAt || d.cancelledAt || d.resolvedAt);
  return {
    resolve: d.canManage && !closed,
    archive: d.canManage && !d.archivedAt,
    cancelNote: d.isOwnRequest && !closed,
    assignOwner: d.canManage && !closed,
    notes: d.canManage,
  };
}

/**
 * Resolution-note confirm gate. Mirrors `maintenanceResolveSchema`'s own
 * `.min(5, ...)` (packages/core/src/schemas/maintenance.ts) so the confirm
 * button enables/disables in lockstep with what the server will actually
 * accept — but this is a CLIENT HINT ONLY, matching the web dialog's own
 * doc comment ("the server re-parses this SAME schema and is the
 * authority"). This function intentionally hand-mirrors ONLY the
 * min-length number rather than importing the zod schema itself (mobile
 * cannot reach into apps/web, and pulling a zod pipeline into a hot render
 * path for one length check is unnecessary weight for a client-side hint).
 * A drift between the two can only fail SAFE: button enabled, server still
 * rejects with its own message — never the reverse (silently blocking a
 * note the server would have accepted).
 */
export function canConfirmResolve(note: string): boolean {
  return note.trim().length >= 5;
}

/**
 * Confirm-flow disclosure (Task 10). Verbatim copy of the web
 * ResolveRequestDialog's DialogDescription (resolve-request-dialog.tsx),
 * minus the interpolated requester name — this is a static export, not a
 * template, so it says "the requester" generically rather than naming them.
 * Never reword this without updating BOTH platforms' copy together; the
 * forbidden-vocabulary sweep below (§GC-4) re-checks it on every change.
 */
export const MOBILE_RESOLVE_DISCLOSURE =
  'Marks this request resolved in StockPilot and emails the requester the note and any proof photos. It does not close or update the Zendesk ticket.';

/** Helper line under the resolution-note field. Computed from the SAME
 *  shared cap the core schema enforces (`MAINTENANCE_RESOLUTION_NOTE_MAX`)
 *  rather than a hand-typed number, so the two can never drift — matches
 *  web's identical `Required. {MAINTENANCE_RESOLUTION_NOTE_MAX} characters
 *  max.` line byte-for-byte. */
export function resolveNoteHelperText(): string {
  return `Required. ${MAINTENANCE_RESOLUTION_NOTE_MAX} characters max.`;
}

export const RESOLVE_NOTE_PLACEHOLDER = 'Describe how this was resolved...';
export const RESOLVE_TOGGLE_LABEL = 'Resolve';
export const RESOLVE_ADD_PHOTO_LABEL = 'Add proof photo';
export const RESOLVE_CONFIRM_LABEL = 'Mark resolved';
export const RESOLVE_PENDING_LABEL = 'Resolving...';
export const RESOLVE_GENERIC_ERROR = "Couldn't mark this resolved. Try again.";

export const ARCHIVE_BUTTON_LABEL = 'Archive';
export const ARCHIVE_CONFIRM_TITLE = 'Archive this maintenance request?';
export const ARCHIVE_CONFIRM_MESSAGE =
  'The request is marked archived and can no longer be edited. Use this to tidy up old resolved or cancelled requests, or duplicates.';
export const ARCHIVE_CANCEL_LABEL = 'Cancel';
export const ARCHIVE_GENERIC_ERROR = "Couldn't archive this request. Try again.";

export const ASSIGN_OWNER_TOGGLE_LABEL = 'Assign owner';
export const ASSIGN_OWNER_SECTION_LABEL = 'StockPilot owner';
export const ASSIGN_OWNER_HELPER =
  'Internal coordinator inside StockPilot. This is not a Zendesk assignment.';
export const ASSIGN_OWNER_UNASSIGNED_LABEL = 'Unassigned';
export const ASSIGN_OWNER_GENERIC_ERROR = "Couldn't update the owner. Try again.";
export const MEMBERS_LOAD_ERROR = "Couldn't load the member list. Try again.";

export const NOTES_TOGGLE_LABEL = 'Internal notes';
export const NOTES_SECTION_LABEL = 'Internal StockPilot notes';
export const NOTES_HELPER =
  'Visible only to StockPilot coordinators. Internal StockPilot notes only — never sent to the requester, never part of a Zendesk ticket thread, and never included in any email.';
export const NOTES_EMPTY = 'No internal notes yet.';
export const NOTES_PLACEHOLDER = 'Add an internal note for other StockPilot coordinators...';
export const NOTES_ADD_LABEL = 'Add note';
export const NOTES_ADD_PENDING_LABEL = 'Adding...';
export const NOTES_TRUNCATED = 'Showing the most recent 500 notes. Older notes are not shown.';
export const NOTES_UNKNOWN_AUTHOR_LABEL = 'StockPilot coordinator';
export const NOTES_ADD_GENERIC_ERROR = "Couldn't add that note. Try again.";
export const NOTES_LOAD_ERROR = "Couldn't load notes. Try again.";

/**
 * Author-name resolution for a note row. Mirrors web's
 * MaintenanceNotesPanel exactly: `(n.authorUserId && authorNames[
 * n.authorUserId]) || 'StockPilot coordinator'`. Mobile has no separate
 * authorNames map fetched server-side (T8's notes route returns raw
 * authorUserId only) — this resolves it against the SAME roster
 * `listMaintenanceMembers()` already fetches for the assign-owner picker,
 * so a note from a removed member (not in the current roster) or a
 * system-authored note (`authorUserId: null`) both fall back to the same
 * generic label web uses, rather than ever rendering a raw uuid.
 */
export function resolveNoteAuthorName(
  authorUserId: string | null,
  members: { userId: string; name: string }[],
): string {
  if (!authorUserId) return NOTES_UNKNOWN_AUTHOR_LABEL;
  return members.find((m) => m.userId === authorUserId)?.name ?? NOTES_UNKNOWN_AUTHOR_LABEL;
}

/**
 * Error-message mapping for the four write actions (resolve/archive/
 * assign-owner/add-note) and their lazy-load reads (members/notes).
 * `ApiError`/`Error` messages from `api()` are already meant for display
 * (api.ts's own doc comment: "message ... remains the ONLY thing that
 * should ever be shown to a person") — this forwards that verbatim, honest
 * per the resolve dialog's own "stays open on error" posture (mirror web:
 * show the SERVER's reason, never blur it into one generic sentence), and
 * only falls back to `fallback` for a non-Error throw or an empty message
 * (e.g. a network layer that rejects with a bare string).
 */
export function mapActionError(e: unknown, fallback: string): string {
  return e instanceof Error && e.message.trim().length > 0 ? e.message : fallback;
}
