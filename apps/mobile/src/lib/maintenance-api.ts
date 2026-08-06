import type {
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
 * No `limit`/`offset` — the route accepts none (Task 11's fixed contract),
 * so this always returns the newest 50 (the service's own default cap).
 * There is nothing this wrapper can do to page past that; screens must show
 * that honestly rather than implying a "load more" that does not exist.
 */
export async function listMaintenanceRequests(args: {
  scope: 'mine' | 'all';
  q?: string;
}): Promise<MobileMaintenanceListRow[]> {
  const usp = new URLSearchParams({ scope: args.scope });
  const q = args.q?.trim();
  if (q) usp.set('q', q);
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
 */
export async function mintPhotoUpload(
  id: string,
  args: { fileExt: string; originalFilename: string },
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
 */
export async function finalizePhoto(
  id: string,
  args: { path: string; thumbPath: string | null; originalFilename: string; declaredMime: string },
): Promise<{ id: string }> {
  return api(`/api/v1/maintenance-requests/${id}/attachments/finalize`, {
    method: 'POST',
    body: {
      path: args.path,
      originalFilename: args.originalFilename,
      declaredMime: args.declaredMime,
    },
  });
}
