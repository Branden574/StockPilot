import 'server-only';

import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';
import type { createClient } from '@/lib/supabase/server';
import { insertAuditRowReported } from '@/server/services/audit';

/**
 * Account deletion, shared by the web self-delete action, the phone's
 * POST /api/v1/account/delete and the platform console's orphan cleanup.
 *
 * WHY THE SERVER ASKS FIRST (migration 0388). `auth.admin.deleteUser` runs
 * `delete from auth.users`, which cascades into roughly a hundred foreign keys.
 * Some of them refuse (RESTRICT or NO ACTION on business records: received
 * stock, imported purchase orders, schedule entries, returns ...), and until
 * 0388 every requester of an order with no email on the row was refused too
 * (order_requests_identity_chk). The web and the phone used to stamp the
 * profile's `deleted_at` and write a `user.deactivated` audit row BEFORE the
 * delete, so a refused delete left a live account marked deleted with a false
 * audit row (and the phone answered 200). Now the server asks
 * `account_deletion_check` (service_role only), which runs the real delete
 * inside a subtransaction that always ends by raising: every cascade, SET NULL
 * and refusal runs and is undone. Nothing is written unless it says the
 * account can go, and the audit row is written only after the delete
 * succeeded.
 *
 * Its lock budget is 900 ms, below Postgres's deadlock_timeout (1 s), so a
 * row lock held by an order write ends the check with 55P03 ("try again")
 * before its wait can make that write a deadlock victim. A caught 40P01 is
 * also "try again". The function never raises either code (PostgREST retries
 * 40001/40P01 forever).
 *
 * EVERY MEMBER (migration 0393). The business keys that refused are SET NULL
 * now: the records stay and read "Deleted user". The one refusal left is the
 * account trigger's: the only owner of an organization that has other members
 * (P0001, constraint organization_last_owner). The web and the phone name the
 * organizations first (soleOwnedOrganizationsWithMembers, the trigger's own
 * predicate read with the user's client); the check's answer is the backstop
 * for a member who joins in between. A platform admin's account is refused
 * in-app while its email is on the allowlist (O-A3-7). The person's avatar
 * files are removed after the delete.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type UserClient = Awaited<ReturnType<typeof createClient>>;

export type AccountDeletionCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       *  - blocked: a record refuses the delete, an integrity refusal
       *    (SQLSTATE class 23: a key, a CHECK, a NOT NULL); after 0393 no
       *    business key refuses, so this is unexpected and reported; the first
       *    refusal's constraint and table are carried for reports;
       *  - last_owner: the account is the only owner of an organization that
       *    has other members (0393, P0001 organization_last_owner): transfer
       *    ownership first;
       *  - retry: a row lock or a deadlock (55P03, 40P01): nothing changed,
       *    try again in a minute;
       *  - check_failed: the check itself could not answer (RPC error,
       *    unexpected shape, or any other error the dry run caught: a
       *    read-only transaction, a lost privilege, a trigger's raise): fail
       *    closed and report it as an error;
       *  - gone: there is no such account (already deleted).
       */
      kind: 'blocked' | 'last_owner' | 'retry' | 'check_failed' | 'gone';
      constraint?: string;
      table?: string;
      sqlstate?: string;
    };

/** Plain sentences (A2 plan 4.5, A3 plan 9.5). Never "book" for a recorded quantity. */
/** An integrity refusal after 0393, which converted every refusing key: unexpected. */
export const ACCOUNT_DELETE_BLOCKED_COPY =
  'Your account could not be deleted because it is linked to a record that could not be released. Nothing was changed. Contact StockPilot support.';
/**
 * The check's last-owner answer (0393), when the app could not name the
 * organization (web). The Team page's control is a member row's "Transfer
 * ownership…" (owner is not in the role list), and removing the other members
 * also lets the account go (a solo organization), so the sentence names both
 * (A3 review).
 */
export const ACCOUNT_DELETE_LAST_OWNER_COPY =
  'You are the only owner of an organization that has other members. On the Team page, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.';
/** The same for the phone, where ownership is transferred on the web (O-A3-8). */
export const ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE =
  'You are the only owner of an organization that has other members. On the Team page on the web, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.';
/** The owner check could not be read (web and phone): nothing changed. */
export const ACCOUNT_DELETE_OWNER_CHECK_FAILED_COPY =
  'Could not check the organizations you own. Nothing was deleted. Try again.';
/** O-A3-7: a platform admin's account is not deleted while its email is on the allowlist. */
export const ACCOUNT_DELETE_PLATFORM_ADMIN_COPY =
  'This account is a StockPilot platform admin. Remove it from the platform admin list before deleting it. Nothing was changed.';
export const ACCOUNT_DELETE_RETRY_COPY =
  'Your account could not be deleted right now. Nothing was changed. Try again in a minute.';
/** After a failed deleteUser: the sessions were revoked (SP-008). */
export const ACCOUNT_DELETE_SIGNED_OUT_COPY =
  'Your account could not be deleted right now. You have been signed out; nothing else changed. Try again in a minute.';

/** Attempts per user per window before the check (each runs a full dry-run cascade). */
export const ACCOUNT_DELETE_RATE_LIMIT = 5;
export const ACCOUNT_DELETE_RATE_WINDOW_MS = 10 * 60_000;
export function accountDeleteRateKey(userId: string): string {
  return `account-delete:${userId}`;
}

const RETRY_SQLSTATES = new Set(['55P03', '40P01']);

/**
 * Only an integrity refusal means "a record the organization keeps".
 * account_deletion_check returns every error its subtransaction catches as
 * reason 'blocked' with the SQLSTATE; anything outside class 23 is the system
 * failing (a read-only transaction answered 25006 and a lost DELETE privilege
 * 42501 in rolled-back probes, review R1), so it must say "try again" and be
 * reported as an error, never "linked to records" at info level.
 */
function isIntegrityRefusal(sqlstate: string): boolean {
  return sqlstate.startsWith('23');
}

/**
 * Ask the database whether `userId`'s account can be deleted. Never throws:
 * every failure is an answer, and every answer that is not `{ ok: true }`
 * means the caller changes nothing.
 */
export async function checkAccountDeletable(
  admin: AdminClient,
  userId: string,
  source: 'web' | 'mobile' | 'platform',
): Promise<AccountDeletionCheck> {
  let data: unknown;
  try {
    const res = (await admin.rpc('account_deletion_check', { p_user_id: userId })) as {
      data: unknown;
      error: { code?: string | null } | null;
    };
    if (res.error) {
      void reportError(new Error('account_deletion_check failed'), {
        tag: 'account.delete.check_failed',
        extra: { source, code: res.error.code ?? null },
      });
      return { ok: false, kind: 'check_failed' };
    }
    data = res.data;
  } catch (e) {
    void reportError(e, { tag: 'account.delete.check_failed', extra: { source } });
    return { ok: false, kind: 'check_failed' };
  }

  const answer = (data ?? {}) as {
    deletable?: unknown;
    reason?: unknown;
    sqlstate?: unknown;
    constraint?: unknown;
    table?: unknown;
  };
  if (answer.deletable === true) return { ok: true };
  if (answer.reason === 'not_found') return { ok: false, kind: 'gone' };
  if (answer.reason === 'blocked') {
    const sqlstate = typeof answer.sqlstate === 'string' ? answer.sqlstate : undefined;
    const constraint = typeof answer.constraint === 'string' ? answer.constraint : undefined;
    const table = typeof answer.table === 'string' ? answer.table : undefined;
    if (sqlstate && RETRY_SQLSTATES.has(sqlstate)) {
      return { ok: false, kind: 'retry', sqlstate };
    }
    // 0393: the account trigger's one refusal. Expected (a member joined
    // between the app's own last-owner read and this check, or an old build
    // that never read it), so info level, names only.
    if (constraint === 'organization_last_owner') {
      void reportError(new Error('account deletion refused: last owner'), {
        tag: 'account.delete.last_owner',
        level: 'info',
        extra: { source, sqlstate: sqlstate ?? null },
      });
      return {
        ok: false,
        kind: 'last_owner',
        ...(sqlstate ? { sqlstate } : {}),
        constraint,
        ...(table ? { table } : {}),
      };
    }
    if (!sqlstate || !isIntegrityRefusal(sqlstate)) {
      void reportError(new Error('account_deletion_check caught an error that is not a refusal'), {
        tag: 'account.delete.check_failed',
        extra: { source, sqlstate: sqlstate ?? null, constraint: constraint ?? null, table: table ?? null },
      });
      return { ok: false, kind: 'check_failed', ...(sqlstate ? { sqlstate } : {}) };
    }
    // After 0393 no business key refuses, so an integrity refusal is a record
    // the census missed: reported as a warning with the constraint and table
    // names only, so support can see what blocks a request without any
    // person's data in the report.
    void reportError(new Error('account deletion blocked'), {
      tag: 'account.delete.blocked',
      level: 'warning',
      extra: { source, sqlstate: sqlstate ?? null, constraint: constraint ?? null, table: table ?? null },
    });
    return {
      ok: false,
      kind: 'blocked',
      ...(sqlstate ? { sqlstate } : {}),
      ...(constraint ? { constraint } : {}),
      ...(table ? { table } : {}),
    };
  }
  // no_user, or a shape this build does not know: fail closed.
  void reportError(new Error('account_deletion_check answered an unknown shape'), {
    tag: 'account.delete.check_failed',
    extra: { source, reason: typeof answer.reason === 'string' ? answer.reason : null },
  });
  return { ok: false, kind: 'check_failed' };
}

/**
 * What happened when `auth.admin.deleteUser` answered an error (review R7).
 *
 *  - deleted_elsewhere: GoTrue answered the DELETE itself with 404
 *    user_not_found, so the account was already gone when this request asked
 *    (another request deleted it, the same person's phone and browser at once).
 *    That request writes its own audit row.
 *  - deleted: any other error (a lost reply: AuthRetryableFetchError status 0;
 *    a 5xx), and GoTrue now says the user does not exist: this request's
 *    delete happened and only its reply failed. The caller writes the audit
 *    row and answers success.
 *  - not_deleted: the account is still there, or GoTrue could not answer the
 *    second question either. The caller keeps its failure answer.
 *
 * Only a 404 that carries code `user_not_found` (both the DELETE and
 * GET /admin/users/<id> answer that for a missing user on GoTrue v2,
 * a2-evidence/review-gotrue-shapes.log) counts as proof. Never throws.
 */
export type FailedDeleteSettlement = 'deleted' | 'deleted_elsewhere' | 'not_deleted';

function isUserNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { status?: unknown; code?: unknown };
  return o.status === 404 && o.code === 'user_not_found';
}

export async function settleFailedDelete(
  admin: AdminClient,
  userId: string,
  deleteError: unknown,
): Promise<FailedDeleteSettlement> {
  if (isUserNotFound(deleteError)) return 'deleted_elsewhere';
  try {
    const { error } = await admin.auth.admin.getUserById(userId);
    return isUserNotFound(error) ? 'deleted' : 'not_deleted';
  } catch {
    return 'not_deleted';
  }
}

/**
 * The account's VERIFIED auth email, read from GoTrue with the admin client
 * (O-A3-7: the platform-admin allowlist is checked against this, never the
 * profile column the person can edit). Used where no user session carries it:
 * the phone's bearer route and the console's orphan cleanup.
 *
 *  - found: the account exists (its email may be null);
 *  - gone: GoTrue answered 404 user_not_found (another request deleted the
 *    account first, review R7): the caller treats it as already deleted;
 *  - failed: any other error or shape: the caller changes nothing.
 * Never throws.
 */
export type AuthEmailRead =
  | { kind: 'found'; email: string | null }
  | { kind: 'gone' }
  | { kind: 'failed'; message: string };

export async function readAuthEmail(admin: AdminClient, userId: string): Promise<AuthEmailRead> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) {
      return isUserNotFound(error)
        ? { kind: 'gone' }
        : { kind: 'failed', message: error.message || 'getUserById failed' };
    }
    if (!data?.user) return { kind: 'failed', message: 'getUserById returned no user' };
    return { kind: 'found', email: data.user.email ?? null };
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : 'getUserById threw' };
  }
}

/**
 * Desk check F-5: GoTrue's delete failed after a passing check. The common
 * cause is the account trigger's own refusal: a member joined the person's
 * solo organization between the check and the delete, so they are now the
 * only owner of an organization with members (P0001 organization_last_owner,
 * which GoTrue answers as a 500). Nothing was deleted, and signing the person
 * out everywhere (SP-008) would punish them for a refusal. So the server asks
 * the check once more: when it answers last_owner, the caller says the
 * last-owner sentence and keeps the sessions; any other answer keeps SP-008.
 * Never throws (checkAccountDeletable never does).
 */
export async function lateLastOwnerRefusal(
  admin: AdminClient,
  userId: string,
  source: 'web' | 'mobile',
): Promise<boolean> {
  const recheck = await checkAccountDeletable(admin, userId, source);
  if (recheck.ok || recheck.kind !== 'last_owner') return false;
  void reportError(new Error('account deletion refused after the check: last owner'), {
    tag: 'account.delete.late_last_owner',
    level: 'info',
    extra: { source },
  });
  return true;
}

/** O-A3-5: what the person created in an organization that keeps working after the deletion. */
export interface CreatedStillActive {
  apiKeys: number;
  webhooks: number;
  publicRequestLinks: number;
  shareLinks: number;
}

/**
 * What a deletion leaves for others to review, read BEFORE the delete (it
 * nulls created_by and cascades the memberships) and used AFTER it succeeded:
 *  - createdStillActive (O-A3-5): the API keys, webhooks (integration
 *    endpoints), public request links and maintenance share links the person
 *    created in the organization the audit row is filed under that still work
 *    (not revoked, enabled, active). They keep working (they belong to the
 *    organization); the counts go in the audit row so its admins can review
 *    them. Null when there is no such organization or a read failed.
 *  - soloPaidOrganizationIds (O-A3-2): organizations the person is the only
 *    real member of (the deletion is allowed and leaves them with no members)
 *    that have a Stripe subscription. Nothing cancels it, so the platform
 *    admin is told (reportDeletionReviewFacts).
 * Reads only; every failure is reported and never holds up the deletion.
 */
export interface DeletionReviewFacts {
  createdStillActive: CreatedStillActive | null;
  soloPaidOrganizationIds: string[];
}

type CountRead = { count: number | null; error: { message: string } | null };

async function countCreatedStillActive(
  admin: AdminClient,
  userId: string,
  organizationId: string,
): Promise<CreatedStillActive> {
  const head = { count: 'exact' as const, head: true };
  const [apiKeys, webhooks, publicRequestLinks, shareLinks] = (await Promise.all([
    admin
      .from('api_keys')
      .select('id', head)
      .eq('created_by', userId)
      .eq('organization_id', organizationId)
      .is('revoked_at', null),
    admin
      .from('integration_endpoints')
      .select('id', head)
      .eq('created_by', userId)
      .eq('organization_id', organizationId)
      .eq('enabled', true),
    admin
      .from('public_request_links')
      .select('id', head)
      .eq('created_by', userId)
      .eq('organization_id', organizationId)
      .eq('active', true),
    admin
      .from('maintenance_request_share_links')
      .select('id', head)
      .eq('created_by', userId)
      .eq('organization_id', organizationId)
      .eq('active', true)
      .is('revoked_at', null),
  ])) as unknown as CountRead[];
  const n = (r: CountRead | undefined): number => {
    if (!r || r.error) throw new Error(r?.error?.message ?? 'count read failed');
    return r.count ?? 0;
  };
  return {
    apiKeys: n(apiKeys),
    webhooks: n(webhooks),
    publicRequestLinks: n(publicRequestLinks),
    shareLinks: n(shareLinks),
  };
}

async function soloOwnedOrganizationsWithSubscription(
  admin: AdminClient,
  userId: string,
): Promise<string[]> {
  const { data: ownedRows, error: ownedErr } = await admin
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null);
  if (ownedErr) throw new Error(ownedErr.message);
  const ownedIds = [
    ...new Set(((ownedRows as { organization_id: string }[] | null) ?? []).map((r) => r.organization_id)),
  ];
  if (ownedIds.length === 0) return [];

  const { data: otherRows, error: othersErr } = await admin
    .from('organization_members')
    .select('organization_id')
    // in-list-bound: the orgs this one user owns (a handful)
    .in('organization_id', ownedIds)
    .neq('user_id', userId)
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null);
  if (othersErr) throw new Error(othersErr.message);
  const withOthers = new Set(
    ((otherRows as { organization_id: string }[] | null) ?? []).map((r) => r.organization_id),
  );
  const soloIds = ownedIds.filter((id) => !withOthers.has(id));
  if (soloIds.length === 0) return [];

  const { data: orgRows, error: orgErr } = await admin
    .from('organizations')
    .select('id')
    // in-list-bound: a subset of the orgs this one user owns
    .in('id', soloIds)
    .not('stripe_subscription_id', 'is', null);
  if (orgErr) throw new Error(orgErr.message);
  return ((orgRows as { id: string }[] | null) ?? []).map((o) => o.id);
}

export async function readDeletionReviewFacts(
  admin: AdminClient,
  userId: string,
  organizationId: string | null,
  source: 'web' | 'mobile',
): Promise<DeletionReviewFacts> {
  const [created, soloPaid] = await Promise.all([
    (async (): Promise<CreatedStillActive | null> => {
      if (!organizationId) return null;
      try {
        return await countCreatedStillActive(admin, userId, organizationId);
      } catch (e) {
        void reportError(e, { tag: 'account.delete.review_counts', level: 'warning', extra: { source } });
        return null;
      }
    })(),
    (async (): Promise<string[]> => {
      try {
        return await soloOwnedOrganizationsWithSubscription(admin, userId);
      } catch (e) {
        // Unknown whether a subscription keeps billing: reported, so a
        // platform admin can look.
        void reportError(e, { tag: 'account.delete.review_subscription', level: 'warning', extra: { source } });
        return [];
      }
    })(),
  ]);
  return { createdStillActive: created, soloPaidOrganizationIds: soloPaid };
}

/**
 * After the delete succeeded (O-A3-2): tell the platform admin which
 * organizations the person leaves with no member while a Stripe subscription
 * keeps billing. Ids only, no personal data. Nothing when there is none.
 */
export function reportDeletionReviewFacts(facts: DeletionReviewFacts, source: 'web' | 'mobile'): void {
  if (facts.soloPaidOrganizationIds.length === 0) return;
  void reportError(new Error('The only member of an organization with a Stripe subscription deleted their account'), {
    tag: 'account.delete.solo_owner_subscription',
    level: 'info',
    extra: { source, organizationIds: facts.soloPaidOrganizationIds.join(',') },
  });
}

/**
 * The `user.deactivated` audit row, written AFTER the delete succeeded.
 *
 * `user_id` is null: the profile is gone, and the row an earlier build wrote
 * before the delete ended up the same way once the FK nulled it.
 * `organization_id` is the organization the request acted in, read before the
 * delete (null for a person with no membership, SP-129: this path writes their
 * row too, where `audit()`'s organization gate dropped it). The entity id keeps
 * who it was.
 */
export async function auditAccountDeleted(args: {
  userId: string;
  organizationId: string | null;
  reason: 'self_deletion' | 'self_deletion_mobile';
  /** O-A3-5: what the person created in this organization that keeps working
   *  (read before the delete by readDeletionReviewFacts); omitted when unread. */
  createdStillActive?: CreatedStillActive | null;
}): Promise<boolean> {
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null;
    userAgent = h.get('user-agent') || null;
  } catch {
    // No request scope: the row is still written without them.
  }
  return insertAuditRowReported({
    organization_id: args.organizationId,
    user_id: null,
    event: 'user.deactivated',
    ip,
    user_agent: userAgent,
    metadata: {
      entity_type: 'user',
      entity_id: args.userId,
      warehouse_id: null,
      before: null,
      after: null,
      reason: args.reason,
      ...(args.createdStillActive
        ? {
            created_still_active: {
              api_keys: args.createdStillActive.apiKeys,
              webhooks: args.createdStillActive.webhooks,
              public_request_links: args.createdStillActive.publicRequestLinks,
              share_links: args.createdStillActive.shareLinks,
            },
          }
        : {}),
    },
    // 0393: the actor is the person who just deleted their account, so the
    // log reads "Deleted user", not "System" (the trigger keeps this stamp:
    // a service_role insert, user_id null).
    deleted_users: { user_id: new Date().toISOString() },
  });
}

/** The organizations a user is the only real owner of while other real members remain. */
export type SoleOwnedOrganizations =
  | { ok: true; organizations: Array<{ id: string; name: string | null }> }
  | { ok: false; message: string };

/**
 * The organizations `userId` is the only owner of while other members remain:
 * the account trigger's last-owner predicate (0393), read with the USER's
 * client so RLS shows the co-members and the organization names.
 *
 * "Real member" means accepted and not an "Act as" impersonation seat
 * (impersonation_expires_at null), everywhere: the person's own owner rows,
 * another owner and another member. A seat is neither a second owner nor
 * another member (critique C1); a pending member does not count (an org with
 * only pending members is a solo org). Disabled accounts still count.
 *
 * Fails CLOSED: a failed read is an answer the caller refuses on (as the
 * pre-0393 owner check did), never "owns nothing". A failed NAME read still
 * refuses, with the organizations unnamed.
 */
export async function soleOwnedOrganizationsWithMembers(
  supabase: UserClient,
  userId: string,
): Promise<SoleOwnedOrganizations> {
  const { data: ownedRows, error: ownedErr } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', userId)
    .eq('role', 'owner')
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null);
  if (ownedErr) return { ok: false, message: ownedErr.message };
  const ownedIds = [
    ...new Set(((ownedRows as { organization_id: string }[] | null) ?? []).map((r) => r.organization_id)),
  ];
  if (ownedIds.length === 0) return { ok: true, organizations: [] };

  const { data: memberRows, error: membersErr } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    // in-list-bound: the orgs this one user owns (a handful)
    .in('organization_id', ownedIds)
    .neq('user_id', userId)
    .not('accepted_at', 'is', null)
    .is('impersonation_expires_at', null);
  if (membersErr) return { ok: false, message: membersErr.message };

  const byOrg = new Map<string, { owners: number; members: number }>();
  for (const m of (memberRows as { organization_id: string; role?: string | null }[] | null) ?? []) {
    const e = byOrg.get(m.organization_id) ?? { owners: 0, members: 0 };
    e.members += 1;
    if (m.role === 'owner') e.owners += 1;
    byOrg.set(m.organization_id, e);
  }
  const blocking = ownedIds.filter((id) => {
    const e = byOrg.get(id);
    return e !== undefined && e.members > 0 && e.owners === 0;
  });
  if (blocking.length === 0) return { ok: true, organizations: [] };

  const { data: orgRows, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name')
    // in-list-bound: a subset of the orgs this one user owns
    .in('id', blocking);
  const nameById = new Map<string, string>();
  if (!orgErr) {
    for (const o of (orgRows as { id: string; name: string | null }[] | null) ?? []) {
      if (o.name?.trim()) nameById.set(o.id, o.name.trim());
    }
  }
  return {
    ok: true,
    organizations: blocking.map((id) => ({ id, name: nameById.get(id) ?? null })),
  };
}

/**
 * The refusal sentence naming the organizations (plan 5, A3 review wording):
 * "You are the only owner of A and B. For each, on the Team page [on the
 * web], choose Transfer ownership on another member, or remove the other
 * members, then delete your account. Nothing was changed." Unnamed
 * organizations (a failed name read) fall back to the generic sentence.
 */
export function lastOwnerCopy(names: readonly (string | null)[], surface: 'web' | 'mobile'): string {
  const named = names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  if (named.length === 0 || named.length !== names.length) {
    return surface === 'mobile' ? ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE : ACCOUNT_DELETE_LAST_OWNER_COPY;
  }
  const where = surface === 'mobile' ? ' on the web' : '';
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  const lead = named.length > 1 ? `For each, on the Team page${where}` : `On the Team page${where}`;
  return `You are the only owner of ${list}. ${lead}, choose Transfer ownership on another member, or remove the other members, then delete your account. Nothing was changed.`;
}

/** Storage list/remove page size: the API's own limit. */
const AVATAR_PAGE = 1000;

/**
 * Best-effort removal of the person's avatar files (user-avatars/<uid>/, a
 * public bucket) AFTER their account is gone (O-A3-9). Lists and removes in
 * pages of at most 1,000 objects; any failure is reported, never thrown: the
 * account is already deleted and the caller's answer must not change.
 */
export async function removeAvatarObjects(admin: AdminClient, userId: string): Promise<void> {
  try {
    const bucket = admin.storage.from('user-avatars');
    // Bounded: 10 pages is 10,000 files, far beyond any real avatar folder.
    for (let page = 0; page < 10; page += 1) {
      const { data, error } = await bucket.list(userId, { limit: AVATAR_PAGE });
      if (error) {
        void reportError(new Error(error.message), { tag: 'account.delete.avatar_list', level: 'warning' });
        return;
      }
      const names = ((data as { name?: string | null }[] | null) ?? [])
        .map((o) => o.name ?? '')
        .filter((n) => n.length > 0);
      if (names.length === 0) return;
      const { error: removeErr } = await bucket.remove(names.map((n) => `${userId}/${n}`));
      if (removeErr) {
        void reportError(new Error(removeErr.message), { tag: 'account.delete.avatar_remove', level: 'warning' });
        return;
      }
      if (names.length < AVATAR_PAGE) return;
    }
  } catch (e) {
    void reportError(e, { tag: 'account.delete.avatar_remove', level: 'warning' });
  }
}
