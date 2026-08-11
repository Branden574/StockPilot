import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  can,
  formatMaintenanceRequestNumber,
  MAINTENANCE_SHARE_LINK_TTL_DAYS,
  type MaintenanceAttachmentKind,
} from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';

import { audit } from './audit';
import { assertModuleEnabled, assertPermission, ServiceError, type ServiceContext } from './context';

// Same fallback the rest of the app uses when building an absolute app URL
// server-side (maintenance-requests.ts's own APP_URL, order-requests.ts:
// 2378/3220) — never window.location, since this runs server-side and the
// resolver below has no request context at all (anonymous caller).
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';

// Bucket id from migration 0315 — same private, org-prefixed bucket Task 9's
// MaintenanceAttachmentsService reads. The anonymous share-page viewer has
// no ServiceContext (no session at all); photo BYTES are streamed to it by
// `/m/[token]/photo/[n]/route.ts` on the ADMIN client (its own BUCKET
// constant — see `resolveMaintenanceSharePhoto` below). Nothing in THIS
// file ever mints a signed URL for a photo (fix wave C1 — a signed URL's
// query string embeds the bucket name plus the org/request/attachment
// UUIDs verbatim, which is exactly the storage-path leak brief §10
// forbids), so there is no bucket constant to declare here at all.

/** The three (and only three) mime types migration 0314's
 *  `maintenance_request_attachments.mime_type` CHECK constraint allows —
 *  every row in the table already satisfies this at the DB layer; repeated
 *  here only so the proxy route has a real TS union to switch on instead of
 *  a bare `string`. */
export type MaintenanceAttachmentMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Matches the /r and /m public-token mint shape (migrations 0261/0314; the
 *  plaintext is hashed at rest since 0330): 64 hex characters from
 *  `crypto.getRandomValues(32 bytes)`. This regex is a
 *  stricter pre-DB-hit guard — every token this service ever mints is
 *  lowercase hex (`mintToken` below always lower-cases via `toString(16)`),
 *  so anything else is provably not a real token and short-circuits BEFORE
 *  the admin client (and its round trip) is ever touched. No `/i` flag
 *  (fix wave m7): an uppercase-hex input can never match a token this
 *  service actually minted, so accepting one here would only widen the
 *  probe surface for free, not real callers.
 */
const TOKEN_SHAPE = /^[0-9a-f]{16,128}$/;

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex digest of the FULL token. Two jobs since migration 0330:
 *
 *  1. THE at-rest form of the credential itself —
 *     `maintenance_request_share_links.token_hash` stores only this digest,
 *     and `resolveActiveShareRequest` compares the presented plaintext's
 *     digest against it (DB equality on a 256-bit-random input's hash; a
 *     timing-safe compare buys nothing here — an anonymous HTTP caller
 *     cannot measure a btree index comparison through pooling and network
 *     jitter, and the input has no low-entropy structure for a timing
 *     oracle to exploit).
 *  2. The rate-limit bucket key shared by every public `/m/<token>` surface
 *     (the page AND the photo proxy route key off the SAME bucket per
 *     token, fix wave C1/m6). Never a raw or sliced token: a
 *     `rate_limit_buckets` row keyed by `token.slice(0, 32)` persists a
 *     working CREDENTIAL FRAGMENT at rest (GC 27).
 *
 *  Same `createHash('sha256')` convention `/r/confirm/submit/route.ts`
 *  already uses for its own public token.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

/** Same recipe as `/m/[token]/page.tsx`'s own `formatSubmittedDate` —
 *  duplicated here deliberately (this is the resolver's projection, not
 *  the page's rendering concern) so `resolution.resolvedAtDisplay` arrives
 *  already formatted and matches the page's "Submitted:" line exactly. */
function formatResolvedAtDisplay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function toShareLink(token: string, expiresAt: string): MaintenanceShareLink {
  return { token, url: `${APP_URL}/m/${token}`, expiresAt };
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
  photos: { filename: string; kind: MaintenanceAttachmentKind }[];
  /** D2/spec §4.2 — present only once the request is resolved. Deliberately
   *  NO resolver name on this anonymous surface (the allow-list posture:
   *  DC4/Andrew need the evidence and the outcome, not a staff directory —
   *  the requester's own email is where the resolver's name belongs).
   *  `resolvedAtDisplay` is pre-formatted server-side (same recipe as this
   *  page's own `formatSubmittedDate` helper — duplicated intentionally,
   *  not shared, since this is the resolver's projection, not the page's
   *  rendering concern) so the page never has to parse/reformat a date. */
  resolution: { note: string; resolvedAtDisplay: string } | null;
}

/** What the photo PROXY route needs for exactly one photo — the raw storage
 *  path and the STORED (sniffed-at-upload) mime type. Deliberately a
 *  SEPARATE, narrower type from `ResolvedMaintenanceShare`: the page-facing
 *  projection above must stay genuinely storage-path-free (its own doc
 *  comment and its test suite both pin that), so this type — and the
 *  function that returns it — exist only for the one server-side caller
 *  that legitimately needs a raw path: the proxy route streaming bytes on
 *  the service-role client. Never pass this to anything that renders HTML. */
export interface ResolvedMaintenanceSharePhoto {
  storagePath: string;
  mimeType: MaintenanceAttachmentMime;
  filename: string;
}

interface AttachmentRow {
  storage_path: string;
  mime_type: string;
  safe_filename: string;
  kind: MaintenanceAttachmentKind;
}

const ALLOWED_MIME = new Set<string>(['image/png', 'image/jpeg', 'image/webp']);

/** Defensive per-row validity check (fix wave m4 — "keep the per-photo skip
 *  as-is"). Every column here is NOT NULL / CHECK-constrained at the DB
 *  layer (migration 0314), so a row should never actually fail this in
 *  practice; it exists so one malformed/legacy row can never crash or
 *  block the rest of the list, mirroring the resilience the OLD
 *  (signing-based) implementation had for a broken photo. Both
 *  `resolveMaintenanceShareToken` and `resolveMaintenanceSharePhoto` apply
 *  this SAME filter before indexing, so the Nth item in the page's photo
 *  list and `GET /m/<token>/photo/<N>` always refer to the same photo. */
function isValidAttachmentRow(row: AttachmentRow): boolean {
  return (
    typeof row.storage_path === 'string' &&
    row.storage_path.length > 0 &&
    typeof row.safe_filename === 'string' &&
    row.safe_filename.length > 0 &&
    ALLOWED_MIME.has(row.mime_type)
  );
}

/**
 * THE single resolver funnel (fix wave C1 doc note, formalized): the ONLY
 * place a token gets checked against `maintenance_request_share_links` —
 * shape, existence, `active`, `expires_at`. `resolveMaintenanceShareToken`
 * (the page's projection) and `resolveMaintenanceSharePhoto` (the proxy
 * route's raw-path lookup) both build on exactly this function; neither
 * re-implements the check. A future hash-at-rest migration for the token
 * column, or any other change to what "a valid link" means, only ever
 * touches this one function.
 *
 * Every branch that isn't a full, valid, active, unexpired-token match
 * returns the SAME generic `null` — unknown, revoked, and expired tokens
 * are indistinguishable to every caller of this function (no timing-obvious
 * branch, no distinct message).
 *
 * Mig 0330 (the "future hash-at-rest migration" the paragraph above
 * anticipated): the lookup is now `token_hash = sha256(presented)` — the
 * plaintext exists only in the visitor's URL, never in the database.
 */
async function resolveActiveShareRequest(
  token: string,
): Promise<{ organizationId: string; maintenanceRequestId: string } | null> {
  if (!TOKEN_SHAPE.test(token)) return null;

  const admin = createAdminClient();
  const { data: link } = await admin
    .from('maintenance_request_share_links')
    .select('maintenance_request_id, organization_id, active, expires_at')
    .eq('token_hash', hashShareToken(token))
    .maybeSingle();
  if (!link) return null;
  const row = link as {
    maintenance_request_id: string;
    organization_id: string;
    active: boolean;
    expires_at: string;
  };
  if (!row.active) return null;
  if (isExpired(row.expires_at)) return null;

  return { organizationId: row.organization_id, maintenanceRequestId: row.maintenance_request_id };
}

/** Every attachment row for a resolved (org, request) pair, ordered exactly
 *  like the authenticated detail page (`sort_order`, then `created_at` as an
 *  explicit tiebreaker — spec §4.2/§12.1: every row defaults `sort_order =
 *  0` today, so without a secondary key the tie order between same-
 *  sort_order rows is unguaranteed Postgres behavior, not a deterministic
 *  contract. This is the ONE fetch both the share page and the photo proxy
 *  route build on, so a wobbling tie order would desync `photos[i]` from
 *  `/m/<token>/photo/<i>` for the two callers independently re-running this
 *  same query), and defensively filtered (see `isValidAttachmentRow`).
 *  Shared by both public functions below so their photo lists/indices can
 *  never drift apart. Returns `null` on a query error (fix wave m4 — a
 *  whole-query failure must surface as "this link doesn't resolve", never
 *  silently render as zero photos). */
async function fetchValidAttachments(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  maintenanceRequestId: string,
): Promise<AttachmentRow[] | null> {
  const { data, error } = await admin
    .from('maintenance_request_attachments')
    .select('storage_path, mime_type, safe_filename, kind')
    .eq('maintenance_request_id', maintenanceRequestId)
    .eq('organization_id', organizationId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return null;
  return ((data ?? []) as AttachmentRow[]).filter(isValidAttachmentRow);
}

/**
 * Whether this org wants a share link folded into the compose email / the
 * resolution email — the ONE reader of `organization_modules.settings.
 * includeShareLinksInEmail` (previously three independent private copies:
 * the web detail page, the mobile REST parity route, and now resolve()'s
 * own need to decide whether to mint a link before the at-most-once email
 * fires). `organization_modules.settings` is an unconstrained jsonb blob
 * (0144), so an absent key or a missing row both mean "never configured"
 * and default ON, matching every other module settings reader in this
 * codebase (packages/core/src/b2b/pricing-mode.ts's own precedent). A plain
 * read, not a permission check — the real authorization for MINTING a link
 * still lives entirely in `issueLink` (requester+submit, or manage);
 * this only decides whether a caller even asks. Reads via `ctx.supabase`
 * (RLS-scoped, user-authed) — same client every existing call site already
 * used, never the admin client, since any org member can read their own
 * org's module settings.
 */
export async function maintenanceShareLinksEnabled(ctx: ServiceContext): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'maintenance_requests')
    .maybeSingle();
  const settings = (data as { settings?: unknown } | null)?.settings as
    | { includeShareLinksInEmail?: boolean }
    | null
    | undefined;
  return settings?.includeShareLinksInEmail !== false;
}

export class MaintenanceShareLinksService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Mints a FRESH link for the request, deactivating any currently-active
   * one first — rotate-or-create, never get-or-return. Migration 0330
   * stores only sha256(token) at rest, so an existing row's plaintext is
   * unrecoverable by design: the plaintext returned here is shown/copied
   * ONCE by the caller and never re-displayable. (Pre-0330 this method was
   * `ensureActiveLink` and idempotently returned the stored token; that
   * contract is impossible now, and every caller has moved from
   * mint-at-render to mint-on-explicit-action so a page view can no longer
   * silently invalidate a link someone already emailed out.) URL shape is
   * always `${APP_URL}/m/${token}` — an APP URL, never a signed storage URL
   * (the token IS the credential; nothing storage-shaped belongs in it).
   *
   * `maintenance_request_share_links` carries NO authenticated write policy
   * (0314) — every write here runs on the ADMIN client, deliberately. The
   * READ that decides whether this caller may even ask for a link runs on
   * `ctx.supabase` (RLS-scoped): the 0314 `maintenance_requests_select`
   * policy already answers "requester-own OR read_all OR manage" for plain
   * VISIBILITY — but minting a 180-day, unauthenticated, durable credential
   * for that request is a materially bigger privilege than merely reading
   * it (fix wave I3). A `read_all`-only holder can see every request in the
   * org yet must not be able to hand a stranger a long-lived link to one
   * they don't own; the gate below is `maintenance_requests:manage` UNLESS
   * the caller is the request's OWN requester and still holds `submit` (the
   * same low bar that let them create it in the first place). A caller RLS
   * can't see gets a `not_found` here, never a `forbidden` — same "don't
   * confirm a foreign row exists" posture as `MaintenanceRequestsService.get()`.
   */
  async issueLink(requestId: string): Promise<MaintenanceShareLink> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');

    const { data: parent, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id, requester_user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!parent) throw new ServiceError('not_found', 'Maintenance request not found');

    const row = parent as { id: string; requester_user_id: string | null };
    const isOwningRequester =
      row.requester_user_id === this.ctx.userId && can(this.ctx, 'maintenance_requests:submit');
    if (!isOwningRequester) {
      assertPermission(this.ctx, 'maintenance_requests:manage');
    }

    const admin = createAdminClient();

    // Deactivate ANY currently-active row (active or stale-past-expiry) —
    // the partial unique index `maintenance_request_share_links_one_active_
    // uniq` (0314) allows only ONE active=true row per request, so the
    // fresh insert below would 23505 against a survivor. `revoked_at` stays
    // NULL here on purpose (fix wave m3) — that column records an explicit
    // `revoke()` call by a manage-holder; rotation/expiry are different
    // events, and `revoke()` below stays the only writer of that column.
    const { error: deactivateErr } = await admin
      .from('maintenance_request_share_links')
      .update({ active: false })
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('active', true);
    if (deactivateErr) throw new ServiceError('internal_error', deactivateErr.message);

    const token = mintToken();
    const expiresAt = new Date(
      Date.now() + MAINTENANCE_SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: insErr } = await admin.from('maintenance_request_share_links').insert({
      organization_id: this.ctx.organizationId,
      maintenance_request_id: requestId,
      // Hash at rest (mig 0330): the plaintext exists only in this stack
      // frame and the return value below.
      token_hash: hashShareToken(token),
      active: true,
      expires_at: expiresAt,
      created_by: this.ctx.userId,
    });
    if (insErr) {
      // A concurrent issueLink can still win the race between the
      // deactivate above and this insert (the unique index is what
      // actually serializes it, not this service). Pre-0330 the loser
      // handed back the winner's stored token; with only the hash at rest
      // that is impossible, so the loser reports a retryable conflict —
      // the caller's next explicit attempt rotates again cleanly.
      if (insErr.code === '23505') {
        throw new ServiceError(
          'conflict',
          'A share link was just created for this request. Try again to replace it.',
        );
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
    return toShareLink(token, expiresAt);
  }

  /**
   * Whether an ACTIVE, unexpired link currently exists (and when it
   * expires) — the render-time read the detail page/mobile GET use now
   * that mint-at-render is gone. Same eligibility gate as issueLink()
   * (owning requester with submit, or manage), same not-found posture.
   * Deliberately returns NO token material of any kind.
   */
  async getActiveLinkStatus(requestId: string): Promise<{ expiresAt: string } | null> {
    assertModuleEnabled(this.ctx, 'maintenance_requests');

    const { data: parent, error } = await this.ctx.supabase
      .from('maintenance_requests')
      .select('id, requester_user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!parent) throw new ServiceError('not_found', 'Maintenance request not found');

    const row = parent as { id: string; requester_user_id: string | null };
    const isOwningRequester =
      row.requester_user_id === this.ctx.userId && can(this.ctx, 'maintenance_requests:submit');
    if (!isOwningRequester) {
      assertPermission(this.ctx, 'maintenance_requests:manage');
    }

    const admin = createAdminClient();
    const { data: existing, error: existingErr } = await admin
      .from('maintenance_request_share_links')
      .select('expires_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('maintenance_request_id', requestId)
      .eq('active', true)
      .maybeSingle();
    if (existingErr) throw new ServiceError('internal_error', existingErr.message);
    if (!existing) return null;
    const { expires_at: expiresAt } = existing as { expires_at: string };
    return isExpired(expiresAt) ? null : { expiresAt };
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
 * Fix wave 2 (C1, layer b — defense in depth). Resolves a charter's NAME
 * through a query that is ITSELF `organization_id`-scoped, never through an
 * embed hanging off `maintenance_requests` (the OLD `charters!charter_id
 * (name)` shape this replaced). Under the ADMIN client (RLS bypassed) a
 * PostgREST embed follows the `charter_id` FK regardless of org — the outer
 * `.eq('organization_id', ...)` on the `maintenance_requests` read scopes
 * only THAT row, never the embedded `charters` row it points at. So even
 * after layer (a)'s fix (MaintenanceRequestsService now re-derives
 * charterId against org on every create/update), a row written BEFORE this
 * fix shipped could still carry a foreign-org `charter_id`, and an embed
 * would still hand this ANONYMOUS page's visitor another tenant's site
 * name. A second, independently `organization_id`-scoped lookup cannot leak
 * it: a `charter_id` belonging to a different org simply matches no row
 * here and degrades to null — the same "unknown = null" posture every other
 * lookup in this module already uses, never a thrown error (a charter
 * lookup failure must not turn an otherwise-valid share link into a 404).
 */
async function resolveOrgScopedCharterName(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  charterId: string | null,
): Promise<string | null> {
  if (!charterId) return null;
  const { data } = await admin
    .from('charters')
    .select('name')
    .eq('organization_id', organizationId)
    .eq('id', charterId)
    .maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

/**
 * Anonymous resolution — module-scoped function, no ServiceContext, because
 * the `/m/<token>` visitor has no StockPilot session at all. Builds on the
 * single resolver funnel (`resolveActiveShareRequest`) and returns an
 * explicit ALLOW-LIST projection, not `select('*')` with keys deleted:
 * requestNumber/subject/description/siteName/createdAt/photos/resolution and
 * nothing else. No requester name/email/phone, no internal notes, no local
 * owner, no other requests, and (D2/spec §4.2) NO resolver name either — a
 * resolved request's `resolution` carries only the note and a pre-formatted
 * date, never `resolved_by`/`resolved_by_name_snapshot` (that column is not
 * even in the select below) — and (fix wave C1) NO storage path and NO
 * signed URL: `photos` carries only a `filename` + `kind`, used solely for
 * `alt` text, grid sizing, and the requester-vs-resolution section split.
 * The actual bytes are served by `/m/[token]/photo/[n]/route.ts`, which
 * streams them from Storage on the service-role client and never hands the
 * browser anything storage-shaped either — see `resolveMaintenanceSharePhoto`
 * below for that half.
 *
 * Uses the ADMIN client deliberately: there is no authenticated user to ride
 * RLS with. Every subsequent query is scoped by the RESOLVED link's OWN
 * `organization_id` + `maintenance_request_id` — never by anything else —
 * so a caller can never widen the query past the single request the token
 * actually names. `siteName` specifically goes through
 * `resolveOrgScopedCharterName` (fix wave 2 / C1) rather than an embed on
 * this SELECT — see that function's own doc comment for why an embed here
 * is a cross-tenant disclosure, not just a style preference.
 */
export async function resolveMaintenanceShareToken(
  token: string,
): Promise<ResolvedMaintenanceShare | null> {
  const resolved = await resolveActiveShareRequest(token);
  if (!resolved) return null;

  const admin = createAdminClient();
  const { data: req } = await admin
    .from('maintenance_requests')
    .select('request_number, created_at, subject, description, charter_id, resolved_at, resolution_note')
    .eq('id', resolved.maintenanceRequestId)
    .eq('organization_id', resolved.organizationId)
    .maybeSingle();
  if (!req) return null;
  const reqRow = req as Record<string, unknown>;

  const [siteName, attachments] = await Promise.all([
    resolveOrgScopedCharterName(admin, resolved.organizationId, (reqRow.charter_id as string | null) ?? null),
    fetchValidAttachments(admin, resolved.organizationId, resolved.maintenanceRequestId),
  ]);
  if (attachments === null) return null;

  // D2/spec §4.2 — gated purely on `resolved_at`: resolve() always requires
  // a note (packages/core's maintenanceResolveSchema), so in practice the
  // two are never set independently, but this projection never trusts
  // resolution_note alone to decide "is this request resolved" (a
  // hypothetical null note on an already-resolved row still renders the
  // resolved block, just with an empty note, rather than silently hiding
  // that the request WAS resolved).
  const resolvedAt = reqRow.resolved_at as string | null;
  const resolution = resolvedAt
    ? {
        note: (reqRow.resolution_note as string | null) ?? '',
        resolvedAtDisplay: formatResolvedAtDisplay(resolvedAt),
      }
    : null;

  return {
    requestNumber:
      formatMaintenanceRequestNumber(reqRow.request_number as number, reqRow.created_at as string) ?? 'MR',
    subject: reqRow.subject as string,
    description: reqRow.description as string,
    siteName,
    createdAt: reqRow.created_at as string,
    photos: attachments.map((a) => ({ filename: a.safe_filename, kind: a.kind })),
    resolution,
  };
}

/**
 * The proxy route's ONLY data source (fix wave C1) — same resolver funnel
 * and same defensively-filtered attachment list as
 * `resolveMaintenanceShareToken` above, so `photos[index]` on the page and
 * `GET /m/<token>/photo/<index>` always name the same photo. Returns the
 * RAW storage path and the STORED (sniffed-at-upload, never client-supplied)
 * mime type — this is the one place in the whole feature those are allowed
 * to leave this module, and only into the proxy route's own server-side
 * `admin.storage.download()` call, never into anything rendered or
 * returned to the browser.
 *
 * `index` is bounds-checked here (an out-of-range or negative index is
 * just another "unresolved" outcome, `null`) — the ROUTE never trusts a
 * client-supplied `n` to index anything before this function has validated
 * it against the request's OWN photo count.
 */
export async function resolveMaintenanceSharePhoto(
  token: string,
  index: number,
): Promise<ResolvedMaintenanceSharePhoto | null> {
  if (!Number.isInteger(index) || index < 0) return null;

  const resolved = await resolveActiveShareRequest(token);
  if (!resolved) return null;

  const admin = createAdminClient();
  const attachments = await fetchValidAttachments(
    admin,
    resolved.organizationId,
    resolved.maintenanceRequestId,
  );
  if (attachments === null) return null;

  const row = attachments[index];
  if (!row) return null;

  return {
    storagePath: row.storage_path,
    mimeType: row.mime_type as MaintenanceAttachmentMime,
    filename: row.safe_filename,
  };
}

/**
 * The resolution email's (Task 6) ONLY photo-URL data source. Since mig
 * 0330 the DB holds only sha256(token), so the send path can no longer READ
 * a token back at send time — `MaintenanceRequestsService.resolve()` mints
 * the link (issueLink) while the plaintext is in hand and THREADS it into
 * the email sender, which passes it here as `plaintextToken`. This function
 * verifies that plaintext still names the request's currently ACTIVE,
 * unexpired link (hash compare, org+request scoped — resolve()'s
 * fire-and-forget email can lose a race against an explicit revoke() or a
 * newer rotation, and a dead token must never be embedded into an email)
 * and returns the proof-photo entries. Reuses the SAME
 * `fetchValidAttachments` ordering funnel every other public surface builds
 * on, so the indices returned here are the request's COMBINED
 * attachment-list positions (requester + resolution photos interleaved in
 * `sort_order`/`created_at` order) — exactly what `/m/<token>/photo/<n>`
 * expects, never a locally re-filtered "resolution-only" index that would
 * point at the wrong photo.
 *
 * Deliberately does NOT mint a link — resolve() already decides whether to
 * mint (photos exist + the org's `includeShareLinksInEmail` setting) before
 * the at-most-once email fires. Returns `null` whenever there is nothing
 * usable (no token threaded, or the threaded token no longer matches the
 * live link) so the caller falls back to the renderer's own no-photos
 * fallback line rather than embed a URL that would 404.
 */
export async function listResolutionProofProxyPhotos(
  admin: SupabaseClient,
  organizationId: string,
  maintenanceRequestId: string,
  plaintextToken: string | null,
): Promise<{ token: string; entries: { index: number; filename: string }[] } | null> {
  if (!plaintextToken || !TOKEN_SHAPE.test(plaintextToken)) return null;

  const { data: link } = await admin
    .from('maintenance_request_share_links')
    .select('expires_at')
    .eq('organization_id', organizationId)
    .eq('maintenance_request_id', maintenanceRequestId)
    .eq('token_hash', hashShareToken(plaintextToken))
    .eq('active', true)
    .maybeSingle();
  if (!link) return null;
  const row = link as { expires_at: string };
  if (isExpired(row.expires_at)) return null;

  const attachments = await fetchValidAttachments(admin, organizationId, maintenanceRequestId);
  if (attachments === null) return null;

  const entries = attachments.reduce<{ index: number; filename: string }[]>((acc, a, index) => {
    if (a.kind === 'resolution') acc.push({ index, filename: a.safe_filename });
    return acc;
  }, []);

  return { token: plaintextToken, entries };
}
