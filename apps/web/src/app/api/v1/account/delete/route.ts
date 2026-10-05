import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ACCOUNT_DELETE_BLOCKED_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
  ACCOUNT_DELETE_PLATFORM_ADMIN_COPY,
  ACCOUNT_DELETE_RATE_LIMIT,
  ACCOUNT_DELETE_RATE_WINDOW_MS,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_SIGNED_OUT_COPY,
  accountDeleteRateKey,
  auditAccountDeleted,
  checkAccountDeletable,
  lastOwnerCopy,
  lateLastOwnerRefusal,
  readAuthEmail,
  readDeletionReviewFacts,
  removeAvatarObjects,
  reportDeletionReviewFacts,
  settleFailedDelete,
  soleOwnedOrganizationsWithMembers,
} from '@/server/lib/account-deletion';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';

export const runtime = 'nodejs';

/**
 * Mobile-facing self-deletion endpoint. Mirrors the web's
 * `deleteOwnAccountAction` server action, but authenticated via the
 * standard mobile bearer-token flow (withApiContext) instead of a
 * Next.js session cookie.
 *
 * Apple App Store Review Guideline 5.1.1(v) requires apps with
 * account creation to also expose account deletion inside the app —
 * not just on a website. This route is what the mobile Settings →
 * Delete account button calls.
 *
 * Contract:
 *   POST /api/v1/account/delete
 *   body: { confirm: "DELETE" }
 *   200: { ok: true }                          // the account is gone (also when it was already gone)
 *   400: { error: "validation_error", message }
 *   403: { error: "last_owner", message }      // the only owner of an org with other members (0394),
 *                                              // also when a member joined after the check (F-5)
 *   403: { error: "platform_admin", message }  // an allowlisted platform admin's account (O-A3-7)
 *   403: { error: "account_linked_records", message } // a record still refuses it (unexpected after 0394)
 *   429: { error: "rate_limited", message }    // 5 attempts per 10 minutes
 *   503: { error: "check_failed", message }    // the check could not answer, or a row lock: try again
 *   500: { error: "internal_error", message }  // the delete itself failed (sessions revoked)
 *
 * Every installed phone shows `message` for any non-2xx and stays signed in
 * (settings.tsx performDelete), so these answers need no phone change.
 * Nothing is written before the delete (no profile tombstone); the
 * `user.deactivated` row is written after it succeeded (0388), after the
 * person's avatar files are removed (0394); it records the counts of the API
 * keys, webhooks and links they created that keep working (O-A3-5), and a
 * solo owner's organization with a Stripe subscription is reported to the
 * platform admin (O-A3-2). Ownership is transferred on the
 * web Team page (O-A3-8), so the phone's last-owner sentence points there.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  // Enforce the org's MFA policy before this destructive action, matching the
  // web `deleteOwnAccountAction` gateMfa() check. withApiContext resolves
  // mfaRequired/mfaSatisfied but the route must act on them — otherwise an
  // AAL1 bearer token could delete the account under an MFA-required policy.
  // Error CODE chosen by enrollment, mirroring services/context.ts
  // mfaGateError: an ENROLLED caller gets 'aal2_required' so the mobile
  // step-up screen prompts for a TOTP code, while an unenrolled caller under
  // an MFA-required policy keeps the original 'mfa_required' (enroll first).
  // Telling someone who already has a factor to enroll one is a dead end.
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    return NextResponse.json(
      ctx.mfaEnrolled
        ? {
            error: 'aal2_required',
            message: 'Re-authenticate with MFA before performing this action.',
          }
        : { error: 'mfa_required', message: 'Multi-factor authentication required.' },
      { status: 403 },
    );
  }

  let body: { confirm?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body falls through to validation error
  }

  if (body.confirm !== 'DELETE') {
    return NextResponse.json(
      { error: 'validation_error', message: 'Type DELETE to confirm.' },
      { status: 400 },
    );
  }

  try {
    // The last-owner rule (0394), the account trigger's own predicate read
    // with the caller's client so it can name the organizations: the only
    // accepted owner (impersonation seats count as neither owners nor
    // members) of an org that has other accepted members is refused until
    // ownership moves. Fails CLOSED: a failed read was once "owns nothing"
    // and an account was deleted out from under an org that still had people
    // in it.
    const sole = await soleOwnedOrganizationsWithMembers(
      ctx.supabase as Parameters<typeof soleOwnedOrganizationsWithMembers>[0],
      ctx.userId,
    );
    if (!sole.ok) {
      void reportError(new Error(sole.message), {
        tag: 'account.delete.owner_check',
        extra: { source: 'mobile' },
      });
      return NextResponse.json(
        {
          error: 'internal_error',
          message: 'Could not check the organizations you own. Nothing was deleted. Try again.',
        },
        { status: 500 },
      );
    }
    if (sole.organizations.length > 0) {
      return NextResponse.json(
        {
          error: 'last_owner',
          message: lastOwnerCopy(
            sole.organizations.map((o) => o.name),
            'mobile',
          ),
        },
        { status: 403 },
      );
    }

    // Each attempt runs a full dry-run cascade (row locks on every row that
    // names the person), so 5 per 10 minutes, as on the web.
    const rl = await checkRateLimit(
      accountDeleteRateKey(ctx.userId),
      ACCOUNT_DELETE_RATE_LIMIT,
      ACCOUNT_DELETE_RATE_WINDOW_MS,
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'rate_limited', message: ACCOUNT_DELETE_RETRY_COPY },
        {
          status: 429,
          headers: {
            'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
          },
        },
      );
    }

    // O-A3-7: a platform admin's account is not deleted while its email is
    // on the allowlist. The bearer context carries no email, so it is read
    // from GoTrue (the verified auth email, never the editable profile
    // column). A read that fails changes nothing: try again. No such user:
    // another request deleted the account a moment ago, the same answer as
    // the check's "gone" below (review R7).
    const admin = createAdminClient();
    const authEmail = await readAuthEmail(admin, ctx.userId);
    if (authEmail.kind === 'gone') return NextResponse.json({ ok: true });
    if (authEmail.kind === 'failed') {
      void reportError(new Error(authEmail.message), {
        tag: 'account.delete.platform_admin_check',
        extra: { source: 'mobile' },
      });
      return NextResponse.json(
        { error: 'check_failed', message: ACCOUNT_DELETE_RETRY_COPY },
        { status: 503 },
      );
    }
    if (isPlatformAdmin(authEmail.email)) {
      return NextResponse.json(
        { error: 'platform_admin', message: ACCOUNT_DELETE_PLATFORM_ADMIN_COPY },
        { status: 403 },
      );
    }

    // Ask first (migration 0388): a dry run of the real delete, always undone.
    // Every answer but "deletable" changes nothing.
    const check = await checkAccountDeletable(admin, ctx.userId, 'mobile');
    if (!check.ok) {
      // A member joined between the read above and the check: the trigger's
      // refusal, with the generic sentence.
      if (check.kind === 'last_owner') {
        return NextResponse.json(
          { error: 'last_owner', message: ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE },
          { status: 403 },
        );
      }
      if (check.kind === 'blocked') {
        return NextResponse.json(
          { error: 'account_linked_records', message: ACCOUNT_DELETE_BLOCKED_COPY },
          { status: 403 },
        );
      }
      // gone: the account no longer exists. Reached only in a race: this
      // request's bearer was verified (getUser) while GoTrue still had the
      // user, and another request deleted the account before this check. The
      // phone then signs out and says it was deleted, which is the truth; the
      // request that deleted it wrote the audit row (review R7).
      if (check.kind === 'gone') return NextResponse.json({ ok: true });
      return NextResponse.json(
        { error: 'check_failed', message: ACCOUNT_DELETE_RETRY_COPY },
        { status: 503 },
      );
    }

    // What the deletion leaves for others to review, read now: the delete
    // nulls created_by and cascades the memberships (O-A3-5 counts for the
    // audit row, O-A3-2 subscriptions for the platform admin). Reads only; a
    // failure is reported and never holds the deletion up.
    const organizationId = ctx.organizationId ?? null;
    const review = await readDeletionReviewFacts(admin, ctx.userId, organizationId, 'mobile');

    const { error: authErr } = await admin.auth.admin.deleteUser(ctx.userId);
    // deleteUser can answer an error although the account is gone: GoTrue
    // committed and the reply was lost, or another request deleted it first
    // (404 user_not_found). Ask GoTrue again before answering (review R7).
    const settled = authErr ? await settleFailedDelete(admin, ctx.userId, authErr) : 'deleted';
    // Desk check F-5: the account trigger refused inside GoTrue because a
    // member joined after the check. Nothing was deleted, so the phone stays
    // signed in and is told to transfer ownership on the web (no SP-008).
    if (authErr && settled === 'not_deleted' && (await lateLastOwnerRefusal(admin, ctx.userId, 'mobile'))) {
      return NextResponse.json(
        { error: 'last_owner', message: ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE },
        { status: 403 },
      );
    }
    if (authErr && settled === 'not_deleted') {
      // SP-008 on the phone: this used to log and answer { ok: true }, and the
      // phone signed out and said "Account deleted" while the account was
      // alive. Now, as on the web: report, end the live sessions best-effort,
      // and say it failed. Nothing was written before the delete.
      await reportError(new Error(authErr.message), {
        tag: 'account.delete.auth_delete_failed',
        extra: { userId: ctx.userId, source: 'mobile' },
      });
      try {
        await revokeAllSessionsForUser(ctx.userId);
      } catch (revokeErr) {
        console.error('[v1/account/delete] session revoke failed:', revokeErr);
      }
      return NextResponse.json(
        { error: 'internal_error', message: ACCOUNT_DELETE_SIGNED_OUT_COPY },
        { status: 500 },
      );
    }
    if (authErr) {
      void reportError(new Error(authErr.message), {
        tag: 'account.delete.auth_delete_error_but_gone',
        level: 'warning',
        extra: { userId: ctx.userId, source: 'mobile', settled },
      });
    }

    // The account is gone: now the audit row, through the admin client with
    // the organization this request acted in (user_id null: the profile no
    // longer exists), written by the request that deleted it. It never went
    // through audit()'s withContext() fallback, which redirects on /api (the
    // bug that dropped every mobile row once).
    if (settled === 'deleted') {
      // O-A3-2: a subscription nothing cancels is the platform admin's to review.
      reportDeletionReviewFacts(review, 'mobile');
      // The person's avatar files (O-A3-9), best-effort, then the audit row
      // (O-A3-5: with the counts of what they created that keeps working).
      await removeAvatarObjects(admin, ctx.userId);
      await auditAccountDeleted({
        userId: ctx.userId,
        organizationId,
        reason: 'self_deletion_mobile',
        createdStillActive: review.createdStillActive,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      {
        error: 'internal_error',
        message: e instanceof Error ? e.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
