import 'server-only';

import { can, type Permission, type Role } from '@stockpilot/core';

import { sha256Hex } from '@/lib/token-hash';
import { mfaGateError } from '@/server/services/context';

/**
 * ORDER SECRETS (migration 0389, slice B "order secrets, expand").
 *
 * Every order bearer secret used to sit raw on `order_requests`, which every
 * member of the organization reads (RLS `is_org_member`, column SELECT on
 * every column, the realtime publication, GET /api/v1/orders/[id]). Since
 * 0389:
 *
 *   - a NEW signature token is minted by `generate_order_packing_slips`: the
 *     raw token goes to `order_request_secrets` (service-only: no grant to
 *     anon or authenticated, never published) and the order column holds
 *     `sha256(raw)` as 64 lowercase hex, the same digest `sha256Hex` makes;
 *   - a NEW return token is minted by `order_return_token_ensure` into the
 *     side table; a NEW public track token is written there by the public
 *     submit.
 *
 * Tokens minted before 0389 (and by a browser tab still running the previous
 * deployment during the 12-hour skew window) stay raw in the order columns
 * until slice C moves and hashes them. So until C every reader here takes the
 * side table first and the order column second, and a signature token found
 * raw in the column is accepted as a link only when NO side token hashes to
 * it. Slice C removes those fallbacks (plan section 6.4).
 *
 * Every function takes the ADMIN client (service_role): nothing else can
 * read `order_request_secrets`. None of them logs, returns to a member, or
 * reports a raw token.
 */

/** The slice of a Supabase client these reads use (the admin client). */
export interface SecretsClient {
  from(table: string): unknown;
}

interface SelectChain {
  select(columns: string): SelectChain;
  eq(column: string, value: string): SelectChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Hand-overs one signed-in member may record per hour through the sign
 * route's member path (R4: 60; the busiest organization recorded at most 3 in
 * any hour and 6 in a day, and a pickup day can bunch them). Keyed by the
 * member, so nobody else can use it up.
 */
export const MEMBER_SIGN_LIMIT_PER_HOUR = 60;

/**
 * Attempts per hour on one signature LINK (the raw token of a printed QR or
 * the panel's link, or a legacy raw column), keyed by the hash of the
 * presented value. Applied only once the token matched as a link: the member
 * path (a digest, which every member reads) never counts against it, so a
 * member who cannot hand the order over cannot lock the entitled phones out
 * (desk check F3).
 */
export const LINK_SIGN_LIMIT_PER_HOUR = 10;

/** 64 hex characters: the shape of every signature token and digest. */
export const SIGNATURE_TOKEN_RE = /^[0-9a-f]{64}$/i;

export interface OrderSecrets {
  signatureToken: string | null;
  returnToken: string | null;
  publicTrackToken: string | null;
  signatureDataUrl: string | null;
}

/**
 * The order's side-table row. `ok: false` when the read failed (the caller
 * decides how to fail: closed for a signature, column fallback for a link that
 * was already emailed); `secrets: null` when the order has no side row.
 */
export async function readOrderSecrets(
  admin: SecretsClient,
  orderId: string,
): Promise<{ ok: true; secrets: OrderSecrets | null } | { ok: false }> {
  try {
    const { data, error } = await (admin.from('order_request_secrets') as SelectChain)
      .select('signature_token, return_token, public_track_token, signature_data_url')
      .eq('order_request_id', orderId)
      .maybeSingle();
    if (error) return { ok: false };
    if (!data) return { ok: true, secrets: null };
    const r = data as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
    return {
      ok: true,
      secrets: {
        signatureToken: str(r.signature_token),
        returnToken: str(r.return_token),
        publicTrackToken: str(r.public_track_token),
        signatureDataUrl: str(r.signature_data_url),
      },
    };
  } catch {
    return { ok: false };
  }
}

/** True when `raw` is the preimage of the order column's digest. */
export function sideTokenIsLive(sideRaw: string | null, column: string | null): boolean {
  return Boolean(sideRaw && column && sha256Hex(sideRaw) === column);
}

/**
 * The raw signature token to put in a link or a QR for an order whose column
 * holds `column`, or null when the order has none (cleared by reopen or
 * resume, or never minted):
 *   - the side token, when its digest is the column (minted since 0389);
 *   - else the column itself, when no side token hashes to it: a raw token
 *     minted before 0389 or by a pre-deploy tab (until slice C);
 *   - null when the side table could not be read: printing the column then
 *     could put a digest in a QR, which opens nothing for a customer.
 */
export async function signatureLinkToken(
  admin: SecretsClient,
  orderId: string,
  column: string | null,
): Promise<{ token: string; source: 'side' | 'legacy_column' } | null> {
  if (!column) return null;
  const read = await readOrderSecrets(admin, orderId);
  if (!read.ok) return null;
  const sideRaw = read.secrets?.signatureToken ?? null;
  if (sideTokenIsLive(sideRaw, column)) return { token: sideRaw as string, source: 'side' };
  return { token: column, source: 'legacy_column' };
}

/**
 * How a presented signature token reached its order:
 *   - `link`: sha256(presented) is the column. The presented value is the
 *     raw token from a printed QR or the panel's link (minted since 0389).
 *   - `legacy_link`: the presented value IS the column and no side token
 *     hashes to it: a raw token minted before 0389 or by a pre-deploy tab.
 *     Accepted as a link until slice C hashes those columns.
 *   - `member`: the presented value IS the column and a side token hashes to
 *     it, so it is a DIGEST, readable by every member. It completes the
 *     hand-over only for an entitled signed-in member (the caller checks).
 *     A side table that cannot be read also lands here: the caller then
 *     demands the entitled session (fail closed).
 * The digest passed to confirm_order_signature is always the column value.
 */
export type SignatureTokenVia = 'link' | 'legacy_link' | 'member';

export interface SignatureTokenMatch<Row> {
  via: SignatureTokenVia;
  order: Row;
  /** The column value: what confirm_order_signature compares against. */
  columnToken: string;
}

/**
 * Resolve a presented signature token to its order through the admin client.
 * `columns` must include `id`. Null when nothing matches (or a lookup failed:
 * the caller answers its one not-found).
 */
export async function resolveSignatureToken<Row extends { id: string }>(
  admin: SecretsClient,
  presented: string,
  columns: string,
): Promise<SignatureTokenMatch<Row> | null> {
  if (!SIGNATURE_TOKEN_RE.test(presented)) return null;
  const digest = sha256Hex(presented);

  const byDigest = await (admin.from('order_requests') as SelectChain)
    .select(columns)
    .eq('signature_token', digest)
    .maybeSingle();
  if (!byDigest.error && byDigest.data) {
    return { via: 'link', order: byDigest.data as Row, columnToken: digest };
  }

  const byColumn = await (admin.from('order_requests') as SelectChain)
    .select(columns)
    .eq('signature_token', presented)
    .maybeSingle();
  if (byColumn.error || !byColumn.data) return null;
  const order = byColumn.data as Row;

  const read = await readOrderSecrets(admin, order.id);
  if (!read.ok) return { via: 'member', order, columnToken: presented };
  const live = sideTokenIsLive(read.secrets?.signatureToken ?? null, presented);
  return { via: live ? 'member' : 'legacy_link', order, columnToken: presented };
}

/**
 * May this signed-in member hand the order over (collect its signature, print
 * the QR that opens it)? The union of today's audiences, so no installed
 * phone loses its button: effective `orders:approve` (the web actions panel
 * and the signature route's gate; the phone shows the button by manager rank,
 * and every manager holds orders:approve unless an override revoked it, which
 * production has none of) or the order's assigned delivery driver.
 */
export function isHandOverEntitled(
  ctx: { readonly userId: string; readonly role: Role; readonly permissions?: ReadonlySet<Permission> },
  order: { assigned_delivery_user_id: string | null },
): boolean {
  if (can(ctx, 'orders:approve')) return true;
  return order.assigned_delivery_user_id != null && order.assigned_delivery_user_id === ctx.userId;
}

/**
 * The MFA step-up that stands between an entitled member and the order's RAW
 * hand-over link (desk check F2). The sign route's member path answers an
 * entitled member whose session needs a step-up with 403 (R3); the order
 * page's link and the warehouse slip's QR hand over the same order with no
 * session at all, so they follow the same rule `assertPermission` applies to
 * every privileged action: MFA required and not satisfied means no raw link.
 * Null when nothing is in the way; else the reason and the shared words.
 */
export function handOverMfaBlock(ctx: {
  readonly mfaRequired: boolean;
  readonly mfaSatisfied: boolean;
  readonly mfaEnrolled?: boolean;
}): { reason: 'aal2_required' | 'mfa_required'; message: string } | null {
  if (!ctx.mfaRequired || ctx.mfaSatisfied) return null;
  const gate = mfaGateError({ mfaEnrolled: ctx.mfaEnrolled });
  const reason = gate.details?.reason === 'mfa_required' ? 'mfa_required' : 'aal2_required';
  return { reason, message: gate.message };
}

/**
 * The panel's words when the Collect signature link is held back for MFA:
 * what to do, in the panel's own terms (the gate's words name no action).
 */
export function handOverMfaPanelMessage(reason: 'aal2_required' | 'mfa_required'): string {
  return reason === 'mfa_required'
    ? 'Set up multi-factor authentication in Settings to collect a signature.'
    : 'Re-authenticate with MFA to collect a signature.';
}

/** The statuses an order can be signed for at (confirm_order_signature's). */
export const SIGNABLE_STATUSES: readonly string[] = ['staged_for_pickup', 'in_transit'];

/**
 * Does the order page hand the actions panel a "Collect signature" link? Only
 * while the order can be signed, only when the panel shows, only for someone
 * who may hand it over, only when no MFA step-up is outstanding (F2:
 * handOverMfaBlock), and only when a token was minted (the page then reads
 * the raw one with signatureLinkToken). Pure, so the page's rule is testable.
 */
export function handOverLinkWanted(v: {
  showActionsPanel: boolean;
  viewerMayHandOver: boolean;
  mfaBlocked: boolean;
  status: string;
  signatureTokenColumn: string | null;
}): boolean {
  return (
    v.showActionsPanel &&
    v.viewerMayHandOver &&
    !v.mfaBlocked &&
    SIGNABLE_STATUSES.includes(v.status) &&
    v.signatureTokenColumn !== null
  );
}

/**
 * Did the order capture a signature IMAGE (drives the panel's "View
 * signature")? A digital hand-over always did; the method says so even once
 * slice C moves the image off the order row. A paper signature has no image.
 */
export function hasCapturedSignature(row: {
  signature_method?: string | null;
  signature_data_url?: string | null;
}): boolean {
  return row.signature_method === 'digital' || Boolean(row.signature_data_url);
}

/**
 * The order's return token for a link: the side table first, then the legacy
 * column (an older token may already be in the requester's inbox). A failed
 * side read falls back to the column.
 */
export async function resolveReturnToken(
  admin: SecretsClient,
  orderId: string,
  column: string | null,
): Promise<string | null> {
  const read = await readOrderSecrets(admin, orderId);
  return (read.ok ? read.secrets?.returnToken : null) ?? column ?? null;
}

/** The order's public track token: the side table first, then the legacy column. */
export async function resolveTrackToken(
  admin: SecretsClient,
  orderId: string,
  column: string | null,
): Promise<string | null> {
  const read = await readOrderSecrets(admin, orderId);
  return (read.ok ? read.secrets?.publicTrackToken : null) ?? column ?? null;
}

/**
 * The order a requester return token opens: the side table first (tokens
 * minted since 0389), then the legacy column. Null when neither matches or a
 * read failed.
 */
export async function orderIdForReturnToken(
  admin: SecretsClient,
  token: string,
): Promise<string | null> {
  try {
    const side = await (admin.from('order_request_secrets') as SelectChain)
      .select('order_request_id')
      .eq('return_token', token)
      .maybeSingle();
    if (!side.error && side.data) {
      const id = (side.data as { order_request_id?: unknown }).order_request_id;
      if (typeof id === 'string') return id;
    }
    const legacy = await (admin.from('order_requests') as SelectChain)
      .select('id')
      .eq('return_token', token)
      .maybeSingle();
    if (legacy.error || !legacy.data) return null;
    const id = (legacy.data as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
