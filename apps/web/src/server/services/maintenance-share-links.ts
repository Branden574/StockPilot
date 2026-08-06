import 'server-only';

import { formatMaintenanceRequestNumber, MAINTENANCE_SHARE_LINK_TTL_DAYS } from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';

// Same fallback the rest of the app uses when building an absolute app URL
// server-side (maintenance-requests.ts's own APP_URL, order-requests.ts:
// 2378/3220) — never window.location, since this runs server-side and the
// resolver below has no request context at all (anonymous caller).
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

/** Bucket id from migration 0315 — same private, org-prefixed bucket Task 9's
 *  MaintenanceAttachmentsService reads. The anonymous share-page viewer has
 *  no ServiceContext (no session at all), so photo signing is re-implemented
 *  here directly on the ADMIN client rather than reusing that service. */
const BUCKET = 'maintenance-photos';

/** In-app-equivalent TTL for a signed photo URL rendered on the public share
 *  page — same 1-hour window MaintenanceAttachmentsService.signedViewUrls
 *  uses for the authenticated detail page (VIEW_URL_TTL_SEC there). Short on
 *  purpose: the SHARE LINK itself (not this signed URL) is the long-lived,
 *  revocable credential a recipient holds — every page load mints fresh
 *  signed URLs, so nothing photo-shaped outlives a single view. */
const PHOTO_SIGN_TTL_SEC = 60 * 60;

/** Matches organizations.public_request_token / public_request_links.token
 *  (migration 0261): 64 hex characters from `crypto.getRandomValues(32
 *  bytes)`. The DB column only constrains length (16-128); this regex is a
 *  stricter pre-DB-hit guard — every token this service ever mints is
 *  hex, so anything else is provably not a real token and short-circuits
 *  BEFORE the admin client (and its round trip) is ever touched. */
const TOKEN_SHAPE = /^[0-9a-f]{16,128}$/i;

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MaintenanceShareLink {
  token: string;
  url: string;
  expiresAt: string;
}

export interface ResolvedMaintenanceShare {
  requestNumber: string;
  subject: string;
  description: string;
  siteName: string | null;
  createdAt: string;
  photos: { url: string; thumbUrl: string | null; filename: string }[];
}

export class MaintenanceShareLinksService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Returns the existing ACTIVE, unexpired link or mints one. URL shape is
   * always `${APP_URL}/m/${token}` — an APP URL, never a signed storage URL
   * (the token IS the credential; nothing storage-shaped belongs in it).
   *
   * `maintenance_request_share_links` carries NO authenticated write policy
   * (0314) — every write here runs on the ADMIN client, deliberately. The
   * READ that decides whether this caller may even ask for a link runs on
   * `ctx.supabase` (RLS-scoped): the 0314 `maintenance_requests_select`
   * policy already answers "requester-own OR read_all OR manage", which is
   * exactly this method's authorization boundary (brief section 5 — a
   * requester needs their OWN request's link for the outgoing email; a
   * read_all/manage holder needs it too). A caller RLS can't see gets a
   * `not_found` here, never a `forbidden` — same "don't confirm a foreign
   * row exists" posture as `MaintenanceRequestsService.get()`.
   */
  async ensureActiveLink(requestId: string): Promise<MaintenanceShareLink> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');

    const { data: parent, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!parent) throw new ServiceError('not_found', 'Maintenance request not found');

    const admin = createAdminClient();
    const nowIso = new Date().toISOString();

    // Look for ANY currently-active row, regardless of expiry — the partial
    // unique index `maintenance_request_share_links_one_active_uniq` (0314)
    // allows only ONE row with active=true per request, so a stale row past
    // its expires_at (nothing flips `active` automatically on expiry) still
    // occupies that slot and would collide with a fresh insert below.
    const { data: existing, error: existingErr } = await admin
      .from('maintenance_request_share_links')
      .select('token, expires_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('active', true)
      .maybeSingle();
    if (existingErr) throw new ServiceError('internal_error', existingErr.message);

    if (existing) {
      const expired = new Date(existing.expires_at as string).getTime() <= Date.now();
      if (!expired) {
        return {
          token: existing.token as string,
          url: `${APP_URL}/m/${existing.token}`,
          expiresAt: existing.expires_at as string,
        };
      }
      // Stale: deactivate it before minting a fresh row, or the insert
      // below 23505s against the partial unique index.
      const { error: deactivateErr } = await admin
        .from('maintenance_request_share_links')
        .update({ active: false, revoked_at: nowIso })
        .eq('organization_id', this.ctx.organizationId)
        .eq('maintenance_request_id', requestId)
        .eq('active', true);
      if (deactivateErr) throw new ServiceError('internal_error', deactivateErr.message);
    }

    const token = mintToken();
    const expiresAt = new Date(
      Date.now() + MAINTENANCE_SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: insErr } = await admin.from('maintenance_request_share_links').insert({
      organization_id: this.ctx.organizationId,
      maintenance_request_id: requestId,
      token,
      active: true,
      expires_at: expiresAt,
      created_by: this.ctx.userId,
    });
    if (insErr) {
      // A genuine concurrent ensureActiveLink call can still win the race
      // between the `existing` check above and this insert (the unique
      // index is what actually serializes it, not this service). Rather
      // than surface an opaque internal_error to a caller who did nothing
      // wrong, hand back whichever row the index let through.
      if (insErr.code === '23505') {
        const { data: won, error: wonErr } = await admin
          .from('maintenance_request_share_links')
          .select('token, expires_at')
          .eq('organization_id', this.ctx.organizationId)
          .eq('maintenance_request_id', requestId)
          .eq('active', true)
          .maybeSingle();
        if (!wonErr && won) {
          return {
            token: won.token as string,
            url: `${APP_URL}/m/${won.token}`,
            expiresAt: won.expires_at as string,
          };
        }
      }
      throw new ServiceError('internal_error', insErr.message);
    }

    await audit(
      {
        event: 'maintenance_request.share_link_created',
        entityType: 'maintenance_request',
        entityId: requestId,
        extra: { expires_at: expiresAt },
      },
      this.ctx,
    );
    return { token, url: `${APP_URL}/m/${token}`, expiresAt };
  }

  /** manage-only. Deactivates every currently-active link for the request.
   *  Row-confirmed (Task 8/9 lesson — C2): a zero-row update result means
   *  there was no active link to revoke, and must never be mistaken for a
   *  successful revocation that gets audited anyway. */
  async revoke(requestId: string): Promise<void> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');
    assertPermission(this.ctx, 'maintenance_requests:manage');

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('maintenance_request_share_links')
      .update({ active: false, revoked_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('active', true)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'No active share link found for this request.');

    await audit(
      { event: 'maintenance_request.share_link_revoked', entityType: 'maintenance_request', entityId: requestId },
      this.ctx,
    );
  }
}

/**
 * Anonymous resolution — module-scoped function, no ServiceContext, because
 * the `/m/<token>` visitor has no StockPilot session at all. Deliberately
 * the ONLY function that ever turns a token into request data, so a future
 * hash-at-rest migration (recorded, not implemented here) only has to change
 * this one lookup. Every branch that isn't a full, valid, active,
 * unexpired-token match returns the SAME generic `null` — unknown, revoked,
 * and expired tokens are indistinguishable to the caller (no timing-obvious
 * branch, no distinct message).
 *
 * Uses the ADMIN client deliberately: there is no authenticated user to ride
 * RLS with. Every subsequent query is scoped by the RESOLVED link's OWN
 * `organization_id` + `maintenance_request_id` — never by anything else —
 * so a caller can never widen the query past the single request the token
 * actually names.
 *
 * The return shape is an explicit ALLOW-LIST projection, not `select('*')`
 * with keys deleted: requestNumber/subject/description/siteName/createdAt/
 * photos and nothing else. No requester name/email/phone, no internal notes,
 * no local owner, no other requests, no storage path — adding a column to
 * `maintenance_requests` can never leak through this function by accident.
 */
export async function resolveMaintenanceShareToken(
  token: string,
): Promise<ResolvedMaintenanceShare | null> {
  if (!TOKEN_SHAPE.test(token)) return null;

  const admin = createAdminClient();
  const { data: link } = await admin
    .from('maintenance_request_share_links')
    .select('maintenance_request_id, organization_id, active, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (!link) return null;
  const row = link as {
    maintenance_request_id: string;
    organization_id: string;
    active: boolean;
    expires_at: string;
  };
  if (!row.active) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  // Scoped by BOTH fields the link resolution itself just proved — never by
  // anything a caller could otherwise supply (the only input to this whole
  // function is the token).
  const { data: req } = await admin
    .from('maintenance_requests')
    .select('request_number, created_at, subject, description, charters!charter_id(name)')
    .eq('id', row.maintenance_request_id)
    .eq('organization_id', row.organization_id)
    .maybeSingle();
  if (!req) return null;
  const reqRow = req as Record<string, unknown>;

  const { data: atts } = await admin
    .from('maintenance_request_attachments')
    .select('storage_path, thumbnail_path, safe_filename')
    .eq('maintenance_request_id', row.maintenance_request_id)
    .eq('organization_id', row.organization_id)
    .order('sort_order', { ascending: true });

  const photos: { url: string; thumbUrl: string | null; filename: string }[] = [];
  for (const a of (atts ?? []) as Record<string, unknown>[]) {
    const master = await admin.storage
      .from(BUCKET)
      .createSignedUrl(a.storage_path as string, PHOTO_SIGN_TTL_SEC);
    // One broken photo never breaks the page — skip it and keep going.
    if (master.error || !master.data) continue;
    let thumbUrl: string | null = null;
    const thumbnailPath = a.thumbnail_path as string | null;
    if (thumbnailPath) {
      const thumb = await admin.storage.from(BUCKET).createSignedUrl(thumbnailPath, PHOTO_SIGN_TTL_SEC);
      if (!thumb.error && thumb.data) thumbUrl = thumb.data.signedUrl;
    }
    photos.push({
      url: master.data.signedUrl,
      thumbUrl,
      filename: a.safe_filename as string,
    });
  }

  const charter = reqRow.charters as { name?: string } | null;
  return {
    requestNumber:
      formatMaintenanceRequestNumber(reqRow.request_number as number, reqRow.created_at as string) ?? 'MR',
    subject: reqRow.subject as string,
    description: reqRow.description as string,
    siteName: charter?.name ?? null,
    createdAt: reqRow.created_at as string,
    photos,
  };
}
