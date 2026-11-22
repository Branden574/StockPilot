import { NextResponse, type NextRequest } from 'next/server';

import { aalFromJwt, withApiContext } from '@/lib/auth/api-context';
import { bearerTokenFrom } from '@/lib/auth/cross-site-request';
import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { readVerifiedSessionClaimsOf } from '@/lib/auth/verified-claims';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { internalErrorResponse } from '@/server/lib/api-error-response';
import {
  ACCOUNT_DELETE_BLOCKED_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
  ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY,
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
import {
  ACCOUNT_DELETE_AAL2_COPY,
  ACCOUNT_DELETE_CODE_REFUSED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
  confirmDeletionCredential,
  deletionCredentialStillHeld,
  deletionCredentialSupplied,
  type DeletionConfirmedBy,
  type SessionLevelReader,
} from '@/server/lib/account-deletion-credential';
import { revokeAllSessionsForUser } from '@/server/services/platform/sessions';

import { ACCOUNT_DELETE_TYPE_DELETE_COPY } from '@stockpilot/core';

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
 *   body: { confirm: "DELETE", password?: string, code?: string, challenge?: string }
 *         `password` is the account's current password; `code` and
 *         `challenge` are the emailed code and the challenge
 *         POST /api/v1/account/delete/code answered.
 *   200: { ok: true }                          // the account is gone (also when it was already gone)
 *   400: { error: "validation_error", message }
 *   403: { error: "aal2_required", message }   // the account has an authenticator; enter its code
 *   403: { error: "mfa_required", message }    // no password or code sent, under a policy that
 *                                              // requires an authenticator of this member
 *   403: { error: "password_incorrect", message } // the password sent is not correct
 *   403: { error: "code_incorrect", message }  // the code sent is wrong, expired, or not this account's
 *   403: { error: "credential_required", message } // the account changed during the request: confirm again
 *   403: { error: "last_owner", message }      // the only owner of an org with other members (0393),
 *                                              // also when a member joined after the check (F-5)
 *   403: { error: "platform_admin", message }  // an allowlisted platform admin's account (O-A3-7)
 *   403: { error: "account_linked_records", message } // a record still refuses it (unexpected after 0393)
 *   429: { error: "rate_limited", message }    // 5 attempts per 10 minutes; 5 password or code tries per 15
 *   503: { error: "check_failed", message }    // the check could not answer, or a row lock: try again
 *   500: { error: "internal_error", message }  // the delete itself failed (sessions revoked)
 *
 * Every installed phone shows `message` for any non-2xx and stays signed in
 * (settings.tsx performDelete), so these answers need no phone change.
 *
 * How a deletion is confirmed (server/lib/account-deletion-credential): an
 * account with an authenticator needs its code entered (aal2); an account
 * with none confirms with its current password or the emailed code, and then
 * deletes whatever its organization's policy says. This route accepts a
 * request that carries neither too, and then answers by the organization's
 * policy, as it did before the password and the code were added (installed
 * phones send only `confirm`).
 * Nothing is written before the delete (no profile tombstone); the
 * `user.deactivated` row is written after it succeeded (0388), after the
 * person's avatar files are removed (0393); it records the counts of the API
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

  let body: { confirm?: unknown; password?: unknown; code?: unknown; challenge?: unknown } = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch {
    // empty body falls through to validation error
  }
  const credential = {
    password: body.password,
    code: body.code,
    challenge: body.challenge,
  };
  const supplied = deletionCredentialSupplied(credential);

  // The verified level of this request's session, read only when the
  // account has an authenticator: the bearer token's own claim (GoTrue
  // accepted the token in withApiContext), or the cookie session's verified
  // claims when they are this account's.
  const bearer = bearerTokenFrom(req);
  const readLevel: SessionLevelReader = bearer
    ? async () => aalFromJwt(bearer)
    : async () => (await readVerifiedSessionClaimsOf(await createClient(), ctx.userId))?.aal ?? null;

  if (supplied === null) {
    if (!ctx.mfaEnrolled && body.confirm === 'DELETE') {
      logUnconfirmedRequest(
        bearer ? 'bearer' : 'cookie',
        ctx.mfaRequired ? 'mfa_required' : 'policy_optional',
      );
    }
    // No password and no code: the organization's policy decides, with the
    // answers installed phones show. The code is chosen by enrolment, as
    // services/context.ts mfaGateError does: an enrolled caller gets
    // 'aal2_required' (enter the code), an unenrolled one under a requiring
    // policy 'mfa_required'.
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
  }

  if (body.confirm !== 'DELETE') {
    return NextResponse.json(
      { error: 'validation_error', message: ACCOUNT_DELETE_TYPE_DELETE_COPY },
      { status: 400 },
    );
  }

  try {
    // How the first check confirmed this request: null when it sent neither a
    // password nor a code; 'authenticator' when the account's authenticator
    // decided (the body's value is then never checked). Only an input to the
    // last check below, which answers what the audit row records.
    let confirmedBy: DeletionConfirmedBy | null = null;
    if (supplied !== null) {
      // The password or the code, checked before anything else is read about
      // the account. The address is the account's current verified one, read
      // by its id.
      const admin = createAdminClient();
      const address = await readAuthEmail(admin, ctx.userId);
      if (address.kind === 'gone') return NextResponse.json({ ok: true });
      if (address.kind === 'failed') {
        void reportError(new Error(address.message), {
          tag: 'account.delete.credential_address',
          extra: { source: 'mobile' },
        });
        return NextResponse.json(
          { error: 'check_failed', message: ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY },
          { status: 503 },
        );
      }
      const confirmation = await confirmDeletionCredential({
        admin,
        userId: ctx.userId,
        email: address.email,
        readLevel,
        input: credential,
        source: 'phone',
      });
      if (!confirmation.ok) {
        if (confirmation.kind === 'gone') return NextResponse.json({ ok: true });
        return credentialRefusal(confirmation.kind);
      }
      confirmedBy = confirmation.by;
    }

    // The last-owner rule (0393), the account trigger's own predicate read
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
        { error: 'internal_error', message: ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY },
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

    // The last check before the delete: the account's factors, read again by
    // its id, still agree with how this request was confirmed. An
    // authenticator needs aal2. None needs the password or the code checked
    // above; a request that sent neither passes only as the policy answer at
    // the top allowed when the request began, so a session whose factors were
    // removed meanwhile gets no easier path than the password or the code.
    const held = await deletionCredentialStillHeld({
      admin,
      userId: ctx.userId,
      readLevel,
      confirmedBy,
      allowUnconfirmedWithoutFactor: confirmedBy === null && !ctx.mfaRequired,
    });
    if (!held.ok) {
      if (held.kind === 'gone') return NextResponse.json({ ok: true });
      return credentialRefusal(held.kind);
    }

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
        // What the last check held, never what the request carried.
        confirmedBy: held.by,
        createdStillActive: review.createdStillActive,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return internalErrorResponse(e, 'api.v1.account.delete', {
      organizationId: ctx.organizationId,
    });
  }
}

/**
 * One info line per request with the typed word that sent neither a password
 * nor a code, from an account with no authenticator, so the runtime logs can
 * count such requests. Info, not a report: it is an expected request. Fixed
 * words, which way the session came (bearer or cookie) and what the
 * organization's policy answers such a request (mfa_required when it requires
 * an authenticator of this member, policy_optional when it does not): never an
 * id, an address, a token, a header or anything from the body. The method,
 * path, status and time are on the platform's own request record. A failure
 * to write it never changes the answer.
 */
function logUnconfirmedRequest(
  via: 'bearer' | 'cookie',
  answer: 'mfa_required' | 'policy_optional',
): void {
  try {
    console.info(
      '[v1/account/delete] request with no password or code from an account with no authenticator',
      { via, answer },
    );
  } catch {
    // The line is best-effort.
  }
}

/** The answer for a deletion this request did not confirm. Never the password or the code. */
function credentialRefusal(
  kind:
    | 'aal2_required'
    | 'credential_required'
    | 'password_refused'
    | 'code_refused'
    | 'rate_limited'
    | 'check_failed',
): NextResponse {
  switch (kind) {
    case 'aal2_required':
      return NextResponse.json(
        { error: 'aal2_required', message: ACCOUNT_DELETE_AAL2_COPY },
        { status: 403 },
      );
    case 'credential_required':
      return NextResponse.json(
        { error: 'credential_required', message: ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY },
        { status: 403 },
      );
    case 'password_refused':
      return NextResponse.json(
        { error: 'password_incorrect', message: ACCOUNT_DELETE_PASSWORD_REFUSED_COPY },
        { status: 403 },
      );
    case 'code_refused':
      return NextResponse.json(
        { error: 'code_incorrect', message: ACCOUNT_DELETE_CODE_REFUSED_COPY },
        { status: 403 },
      );
    case 'rate_limited':
      return NextResponse.json(
        { error: 'rate_limited', message: ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY },
        { status: 429 },
      );
    default:
      return NextResponse.json(
        { error: 'check_failed', message: ACCOUNT_DELETE_CREDENTIAL_CHECK_FAILED_COPY },
        { status: 503 },
      );
  }
}
