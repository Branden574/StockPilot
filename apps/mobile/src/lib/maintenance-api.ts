import type {
  MaintenanceAttachmentKind,
  MaintenanceEmailInput,
  MaintenancePriority,
  MaintenanceRequestFormValues,
  MaintenanceStatus,
} from '@stockpilot/core';

import { api } from './api';

/**
 * Thin typed wrappers over the mobile `api()` client for the maintenance-
 * requests feature (Task 11's `/api/v1/maintenance-requests*` routes). Every
 * shape below mirrors a server-only interface (server/services/
 * maintenance-requests.ts, maintenance-attachments.ts) that mobile cannot
 * import directly, so it is re-declared here field-for-field rather than
 * imported — the same "mirror, don't reach into apps/web" posture every
 * other *-api.ts wrapper in this directory follows.
 *
 * BINDING CONTRACTS (Task 11's review — do not "fix" these without checking
 * the server first):
 *   - The list route takes NO limit/offset query params, so a caller here
 *     always sees the newest 50 rows (the service's own default cap). There
 *     is no pagination to build against it.
 *   - The create route and the attachment mint route both throw a 409
 *     conflict on rate-limit — never 429. Callers must check `status === 409`.
 *   - Task 10's `resolveMaintenanceRequest`/`archiveMaintenanceRequest` also
 *     throw 409, but theirs is NEVER rate-limiting — it is a genuine STATE
 *     conflict (already resolved/archived/cancelled). Do not special-case
 *     it the way `uploadMaintenancePhoto` special-cases mint's 409; the
 *     server's own message is already the right thing to show verbatim.
 *   - Every non-2xx here throws `ApiError` (api.ts) with a `message` meant
 *     for display and NO machine-readable code beyond that.
 */

/** Mirror of `MaintenanceRequestListRow` (server/services/maintenance-requests.ts). */
export interface MobileMaintenanceListRow {
  id: string;
  requestNumber: number;
  createdAt: string;
  subject: string;
  status: MaintenanceStatus;
  priority: MaintenancePriority;
  category: string | null;
  siteName: string | null;
  requesterName: string;
  requesterUserId: string | null;
  photoCount: number;
  draftOpened: boolean;
  localOwnerUserId: string | null;
}

/** Mirror of `MaintenanceRequestDetail` (server/services/maintenance-requests.ts). */
export interface MobileMaintenanceRequestDetail extends MobileMaintenanceListRow {
  description: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  charterId: string | null;
  warehouseId: string | null;
  building: string | null;
  roomOrArea: string | null;
  department: string | null;
  accessInstructions: string | null;
  relatedItemId: string | null;
  relatedOrderRequestId: string | null;
  relatedRentalId: string | null;
  relatedLocationId: string | null;
  outlookDraftOpenedAt: string | null;
  outlookDraftOpenCount: number;
  archivedAt: string | null;
  cancelledAt: string | null;
  /** Maintenance Resolved (spec §1.1): StockPilot-local close-out record.
   *  resolvedByName is the RESOLVER's display-name snapshot (the same
   *  requester_name_snapshot pattern, taken at write time from the
   *  authenticated profile) — never a live join back to user_profiles. */
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  updatedAt: string;
}

/** Mirror of `SignedMaintenancePhoto` (server/services/maintenance-attachments.ts). */
export interface MobileMaintenancePhoto {
  id: string;
  originalFilename: string;
  url: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  /** Maintenance Resolved (migration 0317): 'requester' for photos attached
   *  at request-creation time (the shipped default), 'resolution' for proof
   *  photos a manage-holder attaches when closing out via resolve(). */
  kind: MaintenanceAttachmentKind;
}

/** Mirror of `MaintenanceAttachmentsService.createUploadUrl`'s return shape. */
export interface MintPayload {
  path: string;
  signedUrl: string;
  token: string;
  thumbPath: string;
  thumbSignedUrl: string;
  thumbToken: string;
}

/**
 * List the caller's own (`scope: 'mine'`) or the whole org's
 * (`scope: 'all'`, 403s server-side without read_all/manage) requests.
 *
 * Task 9 correction: the route DOES accept an optional `status` filter —
 * one of the five real statuses or the synthetic `'active'` shorthand
 * (`saved` OR `draft_opened`, resolved JS-side by the service) — forwarded
 * straight through to the route's own `STATUS_VALUES` allow-list
 * (api/v1/maintenance-requests/route.ts); an unrecognized value there is
 * silently dropped (treated as no filter), never rejected, so this wrapper
 * does not validate it either. A prior version of this comment implied
 * `scope`/`q` were the only params the route accepted — that was stale.
 *
 * No `limit`/`offset` — the route accepts neither (Task 11's fixed
 * contract, unchanged by the above), so this always returns the newest 50
 * (the service's own default cap). There is nothing this wrapper can do to
 * page past that; screens must show that honestly rather than implying a
 * "load more" that does not exist.
 */
export async function listMaintenanceRequests(args: {
  scope: 'mine' | 'all';
  q?: string;
  status?: MaintenanceStatus | 'active';
}): Promise<MobileMaintenanceListRow[]> {
  const usp = new URLSearchParams({ scope: args.scope });
  const q = args.q?.trim();
  if (q) usp.set('q', q);
  if (args.status) usp.set('status', args.status);
  const res = await api<{ requests: MobileMaintenanceListRow[] }>(
    `/api/v1/maintenance-requests?${usp.toString()}`,
  );
  return res.requests;
}

/** Full detail read — the Bearer parity for the web detail page's server load. */
export async function getMaintenanceRequest(id: string): Promise<{
  request: MobileMaintenanceRequestDetail;
  photos: MobileMaintenancePhoto[];
  emailInput: MaintenanceEmailInput;
  canManage: boolean;
}> {
  return api(`/api/v1/maintenance-requests/${id}`);
}

/**
 * Create a maintenance request. `values` is validated against
 * `maintenanceRequestFormSchema` (packages/core/src/schemas/maintenance.ts)
 * SERVER-SIDE — this wrapper does not re-parse it, matching every other
 * *-api.ts create wrapper in this directory.
 */
export async function createMaintenanceRequest(
  values: MaintenanceRequestFormValues,
): Promise<{ id: string }> {
  return api('/api/v1/maintenance-requests', { method: 'POST', body: values });
}

/**
 * Records that the Outlook/Zendesk email draft WAS OPENED — nothing more is
 * knowable (brief §20/21: never 'sent', never 'ticket created'). Task 20
 * calls this right before launching the compose link.
 */
export async function recordDraftOpened(id: string): Promise<{ openCount: number }> {
  return api(`/api/v1/maintenance-requests/${id}/draft-opened`, { method: 'POST' });
}

/**
 * Mint step of the photo-upload flow (Task 19). The caller PUTs bytes
 * straight to Storage with the returned signed URLs, then calls
 * `finalizePhoto`. Route contract: 409 conflict on rate-limit, never 429.
 *
 * `kind` (Task 10) is forwarded verbatim via the whole-object `body: args`
 * below — the mint route's own schema treats it as optional and defaults
 * to 'requester', but it is NOT purely cosmetic here: `createUploadUrl`
 * (maintenance-attachments.ts) scopes its per-kind rate-limit count query
 * by `kind` and manage-gates 'resolution' at THIS step too, before any
 * storage call. `uploadMaintenancePhoto` (maintenance-upload.ts) always
 * sends it explicitly, matching web's `MaintenancePhotosPanel`.
 */
export async function mintPhotoUpload(
  id: string,
  args: { fileExt: string; originalFilename: string; kind?: MaintenanceAttachmentKind },
): Promise<MintPayload> {
  return api(`/api/v1/maintenance-requests/${id}/attachments`, { method: 'POST', body: args });
}

/**
 * Finalize step: the server downloads the just-uploaded object, sniffs its
 * real bytes, and only then records the row.
 *
 * `thumbPath` is accepted in the argument shape for the caller's own
 * bookkeeping (it is what `mintPhotoUpload` handed back, and Task 19's
 * upload flow needs to carry it between the two PUTs and this call), but it
 * is DELIBERATELY NEVER forwarded in the request body. The finalize route's
 * contract (CRITICAL 1c, Task 9 security fix wave) derives thumbPath itself
 * from `path` server-side; a client-supplied one is not part of the schema
 * and web's own finalize call (maintenance-photos-panel.tsx) never sends it
 * either. Sending it here would be dead weight at best.
 *
 * `kind` (Task 10, migration 0317/spec §2.2) is forwarded verbatim — the
 * finalize route's own schema treats it as optional and defaults to
 * 'requester' when omitted, but `uploadMaintenancePhoto` (maintenance-
 * upload.ts) ALWAYS sends it explicitly on both this call and
 * `mintPhotoUpload`'s, matching web's `MaintenancePhotosPanel` (which also
 * always sends its `kind` prop, defaulted to 'requester'). This is the ONE
 * place `MaintenanceAttachmentsService.finalize()` actually records the
 * kind on the row — `mintPhotoUpload`'s copy of `kind` only governs the
 * mint step's own per-kind rate-limit count and manage-gate; a caller that
 * threads it into mint but drops it here would still get a row recorded as
 * 'requester' regardless of what mint saw.
 */
export async function finalizePhoto(
  id: string,
  args: {
    path: string;
    thumbPath: string | null;
    originalFilename: string;
    declaredMime: string;
    kind?: MaintenanceAttachmentKind;
  },
): Promise<{ id: string }> {
  return api(`/api/v1/maintenance-requests/${id}/attachments/finalize`, {
    method: 'POST',
    body: {
      path: args.path,
      originalFilename: args.originalFilename,
      declaredMime: args.declaredMime,
      kind: args.kind,
    },
  });
}

/**
 * Mirror of `MaintenanceNoteRow` (server/services/maintenance-requests.ts
 * `listNotes`'s own return shape). Internal StockPilot coordination notes
 * — never visible to the requester, never synced anywhere (route doc
 * comment: "NEVER visible to the requester, NEVER synced anywhere").
 */
export interface MobileMaintenanceNote {
  id: string;
  authorUserId: string | null;
  body: string;
  createdAt: string;
}

/** Mirror of `MaintenanceOwnerOption` (assign-owner-select.tsx) — the
 *  allow-list projection `fetchAcceptedMembers` returns (userId + display
 *  name only, never email/role/raw member row). */
export interface MobileMaintenanceMember {
  userId: string;
  name: string;
}

/**
 * Manage-only close-out (Task 10 — mobile parity for the web Resolve
 * dialog). `note` is validated against `maintenanceResolveSchema`
 * (packages/core/src/schemas/maintenance.ts, `.strict()`) SERVER-SIDE —
 * this wrapper does not re-parse it, matching every other *-api.ts create/
 * write wrapper in this directory. `canConfirmResolve` (maintenance-
 * actions.ts) is the client-side HINT only.
 *
 * 409-NOT-429 CONTRACT NOTE (unlike this file's `mintPhotoUpload`/
 * `createMaintenanceRequest`, whose 409 always means rate-limit): resolve()
 * throws 409 `conflict` for a genuine STATE conflict — the request is
 * already archived, cancelled, or resolved (server/services/
 * maintenance-requests.ts `resolve()`). Never rate-limited. A caller that
 * special-cased 409 here the way `uploadMaintenancePhoto` special-cases
 * mint's 409 would misreport a real state conflict as "too many requests" —
 * don't. The server's own message ("This request is already resolved.",
 * etc.) is already the right thing to show verbatim; no wrapping needed.
 */
export async function resolveMaintenanceRequest(id: string, note: string): Promise<{ ok: true }> {
  return api(`/api/v1/maintenance-requests/${id}/resolve`, { method: 'POST', body: { note } });
}

/**
 * Manage-only re-bucket (owner decision D1) — mobile parity for the web
 * Archive action. No body: `archive()` takes only the id (route doc
 * comment: "nothing to parse or forward"). Works on an open, resolved, OR
 * cancelled row; 409s with 'This request is already archived.' on a
 * second call against an already-archived one.
 */
export async function archiveMaintenanceRequest(id: string): Promise<{ ok: true }> {
  return api(`/api/v1/maintenance-requests/${id}/archive`, { method: 'POST' });
}

/**
 * Manage-only "StockPilot local owner" assignment (never a Zendesk
 * assignee) — mobile parity for the web AssignOwnerSelect. `userId: null`
 * clears the assignment; sent as an EXPLICIT `null`, never omitted — the
 * route's own schema (`z.object({ userId: z.string().nullable() })
 * .strict()`) requires the key to be present, and an omitted key would
 * fail that `.strict()` parse as a 400 instead of clearing the owner.
 */
export async function assignMaintenanceOwner(
  id: string,
  userId: string | null,
): Promise<{ ok: true }> {
  return api(`/api/v1/maintenance-requests/${id}/assign-owner`, {
    method: 'POST',
    body: { userId },
  });
}

/**
 * Internal notes thread read — manage-only in BOTH directions (route doc
 * comment), NEVER visible to the requester. Unwraps the `{ notes }`
 * envelope, matching this file's `listMaintenanceRequests`/
 * `getMaintenanceRequest` convention of returning the caller-facing shape
 * directly rather than the wire envelope.
 */
export async function listMaintenanceNotes(id: string): Promise<MobileMaintenanceNote[]> {
  const res = await api<{ notes: MobileMaintenanceNote[] }>(
    `/api/v1/maintenance-requests/${id}/notes`,
  );
  return res.notes;
}

/**
 * Adds an internal note. `body`'s 1-4,000 character trim/length rule lives
 * entirely in `MaintenanceRequestsService.addNote()` — this wrapper does
 * not re-validate it, matching the route's own "body-shape gate only"
 * posture (notes/route.ts doc comment).
 */
export async function addMaintenanceNote(id: string, body: string): Promise<{ id: string }> {
  return api(`/api/v1/maintenance-requests/${id}/notes`, { method: 'POST', body: { body } });
}

/**
 * Roster for the mobile assign-owner picker (and, doubling as the source
 * for note-author name resolution — `resolveNoteAuthorName`,
 * maintenance-actions.ts) — mirrors the web AssignOwnerSelect's data
 * source. Server-gated on `maintenance_requests:manage` directly in the
 * route (`can(ctx, ...)`, no service call) — a non-manager calling this
 * gets 403, never a partial/empty roster silently standing in for
 * "no access". Unwraps the `{ members }` envelope.
 */
export async function listMaintenanceMembers(): Promise<MobileMaintenanceMember[]> {
  const res = await api<{ members: MobileMaintenanceMember[] }>(
    '/api/v1/maintenance-requests/members',
  );
  return res.members;
}
