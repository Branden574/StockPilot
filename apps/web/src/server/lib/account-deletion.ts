import 'server-only';

import { headers } from 'next/headers';

import { reportError } from '@/lib/error-reporter';
import type { createAdminClient } from '@/lib/supabase/admin';
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
 */

type AdminClient = ReturnType<typeof createAdminClient>;

export type AccountDeletionCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       *  - blocked: a record the organization keeps refuses the delete (the
       *    first refusal's constraint and table are carried for reports);
       *  - retry: a row lock or a deadlock (55P03, 40P01): nothing changed,
       *    try again in a minute;
       *  - check_failed: the check itself could not answer (RPC error,
       *    unexpected shape): fail closed;
       *  - gone: there is no such account (already deleted).
       */
      kind: 'blocked' | 'retry' | 'check_failed' | 'gone';
      constraint?: string;
      table?: string;
      sqlstate?: string;
    };

/** Plain sentences (plan 4.5). Never "book" for a recorded quantity. */
export const ACCOUNT_DELETE_BLOCKED_COPY =
  "Your account can't be deleted from the app because it is linked to records your organization keeps, such as received stock, imported purchase orders or schedule entries. Nothing was changed. Contact StockPilot support to have it removed.";
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
    // Expected for accounts linked to kept records (plan O-A2-3); reported at
    // info level with the constraint and table names only, so support can
    // see what blocks a request without any person's data in the report.
    void reportError(new Error('account deletion blocked'), {
      tag: 'account.delete.blocked',
      level: 'info',
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
    },
  });
}
