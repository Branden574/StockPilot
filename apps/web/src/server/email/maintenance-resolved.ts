import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { formatMaintenanceRequestNumber } from '@stockpilot/core';

import {
  MAINTENANCE_RESOLVED_FROM,
  renderMaintenanceResolvedEmail,
  type MaintenanceResolvedProofPhoto,
} from '@/lib/email/es/families/maintenance';
import { sendEmail } from '@/lib/email/resend';
import { reportError } from '@/lib/error-reporter';
import { formatOrgDateTime, ORG_TIMEZONE_DEFAULT } from '@/lib/timezone';
import { listResolutionProofProxyPhotos } from '@/server/services/maintenance-share-links';

/**
 * The at-most-once "your maintenance request was marked resolved" email
 * (Task 6, spec §6.1-§6.3). `return-prompt.ts` is this module's structural
 * twin: guard order, guarded-claim-before-send, and best-effort posture all
 * mirror it deliberately (module-for-module, per the T4 stub's own doc
 * comment).
 *
 * Guard order (each a SILENT skip — `sendEmail` is never reached for any of
 * them): row exists -> `status === 'resolved'` -> `requester_email_snapshot`
 * non-null -> `requester_user_id !== resolved_by` (self-resolve: you don't
 * email someone about their own click; mirrors resolve()'s in-app
 * suppression, same two ids) -> cheap `resolution_email_sent_at` pre-check
 * -> the AUTHORITATIVE guarded claim (`.is('resolution_email_sent_at',
 * null)`, only the winner proceeds). Everything below the claim — org
 * timezone read, proof-photo lookup, rendering, the actual send — runs
 * ONLY for the winner, and a failure anywhere in that block reports and
 * returns `send_failed` WITHOUT ever clearing the marker: a missed email is
 * recoverable (the resolution is still on the request in StockPilot); a
 * duplicate is just spam (0278 posture, verbatim).
 *
 * Transport is `sendEmail` from `@/lib/email/resend` ONLY (GC 2) — never
 * the Supabase built-in mailer, never a direct fetch to Resend, never a
 * second path.
 */
export type MaintenanceResolvedEmailResult =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'request_not_found'
        | 'not_resolved'
        | 'no_requester_email'
        | 'self_resolve'
        | 'already_sent'
        | 'lost_race'
        | 'send_failed'
        | 'error';
    };

/** Up to this many proof photos ride IN the email body; the renderer's own
 *  "+N more" line (or, with no active link, the honest fallback sentence)
 *  covers the rest. Duplicated from `families/maintenance.ts`'s own
 *  `PROOF_IMG_MAX` deliberately — that file is template-only (its own test
 *  suite source-scans it for zero transport imports), so the two constants
 *  are pinned equal by test, not by a shared import across that boundary. */
const PROOF_PHOTO_EMBED_MAX = 4;

interface ResolvedRequestRow {
  id: string;
  organization_id: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name_snapshot: string | null;
  resolution_note: string | null;
  requester_user_id: string | null;
  requester_email_snapshot: string | null;
  requester_name_snapshot: string | null;
  request_number: number | null;
  created_at: string | null;
  subject: string | null;
  resolution_email_sent_at: string | null;
}

/** First whitespace-delimited token of a name snapshot, or null — matches
 *  the renderer's own greeting fallback contract ("Hi -" when absent). */
function firstNameOf(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/**
 * Whether this org wants a share link folded into the resolution email —
 * the SAME `organization_modules.settings.includeShareLinksInEmail`
 * predicate `maintenanceShareLinksEnabled(ctx)` reads, but read directly
 * off the admin client + a raw `organizationId` here: this module has no
 * `ServiceContext` (it runs fire-and-forget off `resolve()`, admin client
 * only), so it cannot call that ctx-shaped helper. An absent key or a
 * missing settings row both mean "never configured" and default ON, same
 * as every other reader of this setting.
 */
async function shareLinksEnabledForEmail(
  admin: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data } = await admin
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', organizationId)
    .eq('module_id', 'maintenance_requests')
    .maybeSingle();
  const settings = (data as { settings?: unknown } | null)?.settings as
    | { includeShareLinksInEmail?: boolean }
    | null
    | undefined;
  return settings?.includeShareLinksInEmail !== false;
}

/** The real `kind='resolution'` attachment count, independent of whether a
 *  usable share link exists — the renderer's honest fallback line
 *  ("N proof photos are on the request in StockPilot.") needs the true
 *  total even when there is nothing to link to. */
async function countResolutionPhotos(
  admin: SupabaseClient,
  organizationId: string,
  requestId: string,
): Promise<number> {
  const { count } = await admin
    .from('maintenance_request_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('maintenance_request_id', requestId)
    .eq('kind', 'resolution');
  return count ?? 0;
}

export async function maybeSendMaintenanceResolvedEmail(
  admin: SupabaseClient,
  requestId: string,
  opts: { appUrl: string },
): Promise<MaintenanceResolvedEmailResult> {
  try {
    const { data: row } = await admin
      .from('maintenance_requests')
      .select(
        'id, organization_id, status, resolved_at, resolved_by, resolved_by_name_snapshot, resolution_note, requester_user_id, requester_email_snapshot, requester_name_snapshot, request_number, created_at, subject, resolution_email_sent_at',
      )
      .eq('id', requestId)
      .maybeSingle();
    if (!row) return { sent: false, reason: 'request_not_found' };
    const request = row as ResolvedRequestRow;

    if (request.status !== 'resolved') return { sent: false, reason: 'not_resolved' };
    if (!request.requester_email_snapshot) return { sent: false, reason: 'no_requester_email' };
    // Self-resolve: you don't email someone about their own click. Compares
    // the same two ids resolve()'s in-app notify suppression does
    // (requester_user_id vs the acting user — here, resolved_by).
    if (request.requester_user_id && request.requester_user_id === request.resolved_by) {
      return { sent: false, reason: 'self_resolve' };
    }
    // Cheap pre-check; the guarded update below is the authoritative gate.
    if (request.resolution_email_sent_at) return { sent: false, reason: 'already_sent' };

    // Claim the send BEFORE composing/rendering/sending anything — only the
    // winner of this guarded update proceeds (at-most-once; 0278 posture
    // verbatim). The marker deliberately stays set on a later send failure
    // — see the inner try/catch below.
    const { data: claimed } = await admin
      .from('maintenance_requests')
      .update({ resolution_email_sent_at: new Date().toISOString() })
      .eq('id', requestId)
      .is('resolution_email_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) return { sent: false, reason: 'lost_race' };

    try {
      const { data: org } = await admin
        .from('organizations')
        .select('timezone')
        .eq('id', request.organization_id)
        .maybeSingle();
      const tz = (org as { timezone?: string | null } | null)?.timezone || ORG_TIMEZONE_DEFAULT;
      const resolvedOnDisplay = formatOrgDateTime(
        request.resolved_at ?? new Date().toISOString(),
        {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        },
        tz,
      );

      const handle =
        formatMaintenanceRequestNumber(request.request_number, request.created_at) ??
        `MR-${requestId.slice(0, 8)}`;

      const base = opts.appUrl.replace(/\/+$/, '');

      // Proof photos: reuse the ONE ordering funnel
      // (listResolutionProofProxyPhotos -> fetchValidAttachments) rather
      // than re-deriving indices here — a locally re-filtered
      // "resolution-only" index would desync from what
      // /m/<token>/photo/<n> actually serves.
      const shareEnabled = await shareLinksEnabledForEmail(admin, request.organization_id);
      const proof = shareEnabled
        ? await listResolutionProofProxyPhotos(admin, request.organization_id, requestId)
        : null;

      let proofPhotos: MaintenanceResolvedProofPhoto[];
      let proofPhotoTotal: number;
      if (proof) {
        proofPhotoTotal = proof.entries.length;
        // The embedded /m/{token}/photo/{n} URLs ride the share link's
        // 120/hr fail-closed bucket. Email-client image proxies (Gmail,
        // Outlook ATP) fetch at DELIVERY time, not when humans open the
        // email. One email embeds up to PROOF_PHOTO_EMBED_MAX (~4) requests
        // immediately; paired with the page's own ~17-request full view,
        // this leaves ample headroom at one email per request (at-most-once).
        // Batch-resend features must re-check this budget.
        proofPhotos = proof.entries.slice(0, PROOF_PHOTO_EMBED_MAX).map((e) => ({
          src: `${base}/m/${proof.token}/photo/${e.index}`,
          alt: e.filename,
        }));
      } else {
        // No usable link (none minted, revoked, expired, or the org has
        // share links off) — photos may still exist, so count them
        // directly: the renderer's honest fallback line still needs the
        // real total.
        proofPhotoTotal = await countResolutionPhotos(admin, request.organization_id, requestId);
        proofPhotos = [];
      }

      const rendered = renderMaintenanceResolvedEmail({
        requestHandle: handle,
        requestSubject: request.subject ?? '',
        recipientFirstName: firstNameOf(request.requester_name_snapshot),
        resolverName: request.resolved_by_name_snapshot ?? 'Your team',
        resolutionNote: request.resolution_note ?? '',
        resolvedOnDisplay,
        proofPhotos,
        proofPhotoTotal,
        requestUrl: `${base}/dashboard/maintenance/${requestId}`,
      });

      await sendEmail({
        to: request.requester_email_snapshot,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        from: MAINTENANCE_RESOLVED_FROM,
      });
    } catch (e) {
      // Marker stays set — missed email over duplicate (0278 posture).
      await reportError(e, {
        tag: 'maintenance_resolved.email.send',
        extra: { requestId },
      });
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (e) {
    try {
      await reportError(e, { tag: 'maintenance_resolved.email', extra: { requestId } });
    } catch {
      /* reporting is itself best-effort */
    }
    return { sent: false, reason: 'error' };
  }
}
