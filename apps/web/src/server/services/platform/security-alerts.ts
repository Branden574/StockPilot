import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds, rawErrorText } from '@/server/services/lib/fetch-by-ids';

import {
  ALERT_LIST_DEFAULT,
  SECURITY_ALERTS_FAILED,
  readSecurityAlertList,
  type SecurityAlertChange,
  type SecurityAlertChangeView,
  type SecurityAlertsResult,
} from '@stockpilot/core';

/**
 * The platform console's security alerts (migration 0480, stage 4a: RECORD
 * ONLY): one read of platform_security_alert_list() (the newest 50 alerts
 * and the newest 50 changes), which says what the
 * alert job recorded, what each alert would have done, the job's heartbeat,
 * the thresholds in force and the change history.
 *
 * Read with the service client: the function is granted to service_role
 * only. So this module has no gate of its own, like its sibling platform
 * services, and the files that import it are the doors to that data
 * (security-alerts.callers.test.ts pins them): the alerts section, which only
 * the gated page /platform/security/alerts renders, and the Server Action
 * its "Check again" asks, which asks checkPlatformConsoleRead() first.
 *
 * The read has its own time budget and is checked against the contract's
 * shape by core's strict reader. On any failure (the function missing
 * because the code is ahead of the migration, the database's own cancel, a
 * timeout, a refused state, a shape this build does not know) it is "could
 * not check", reported once as a warning with its code or the place the
 * shape differs, never a value from the answer; never an empty list in a
 * failed read's place. Nothing here throws.
 *
 * Each change's actor is a user id; the page shows that person's sign-in
 * email, looked up here in user_profiles (at most 64 ids). A lookup that
 * fails or is slow leaves the emails out (the page says "a platform admin"),
 * and is reported once: the list itself is still shown. The organization
 * names are only those the list returns (an aimed alert's organization);
 * nothing else about any organization is read.
 */

/** How long the list may take before the page gives up on it. */
export const SECURITY_ALERTS_READ_BUDGET_MS = 6_000;
/** How long the actors' emails may take before they are left out. */
export const SECURITY_ALERTS_ACTORS_BUDGET_MS = 3_000;

const FN = 'platform_security_alert_list';
const TAG = `platform.security-alerts.${FN}`;

function codeOf(error: unknown): string | null {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : null;
}

/** The sign-in email of each actor, by user id. A failure answers an empty map, reported once. */
async function actorEmails(changes: readonly SecurityAlertChange[]): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  const ids = [...new Set(changes.map((c) => c.actorUserId))];
  if (ids.length === 0) return byId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const admin = createAdminClient();
    const work = fetchAllRowsByIds<{ id?: unknown; email?: unknown }>(
      ids,
      (batch) => (from, to) =>
        admin.from('user_profiles').select('id, email').in('id', batch).order('id').range(from, to),
    );
    work.catch(() => undefined);
    const rows = await Promise.race([
      work,
      new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), SECURITY_ALERTS_ACTORS_BUDGET_MS);
      }),
    ]);
    if (rows === 'late') throw new Error('the actors’ emails took too long');
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.email === 'string' && row.email.length <= 320) {
        byId.set(row.id, row.email);
      }
    }
  } catch (err) {
    await reportError(new Error(rawErrorText(err)), {
      tag: 'platform.security-alerts.actor-emails',
      level: 'warning',
      extra: { count: ids.length },
    });
    byId.clear();
  } finally {
    clearTimeout(timer);
  }
  return byId;
}

/** One read of the alerts. Never throws, and never answers the gate's refusal. */
export async function readPlatformSecurityAlerts(): Promise<SecurityAlertsResult> {
  const fail = async (problem: Error, extra: Record<string, string | null>) => {
    await reportError(problem, { tag: TAG, level: 'warning', extra });
    return SECURITY_ALERTS_FAILED;
  };
  try {
    const { data, error } = (await createAdminClient()
      .rpc('platform_security_alert_list', {
        p_limit: ALERT_LIST_DEFAULT,
        p_changes: ALERT_LIST_DEFAULT,
      })
      .abortSignal(AbortSignal.timeout(SECURITY_ALERTS_READ_BUDGET_MS))) as {
      data: unknown;
      error: { message?: string; code?: string } | null;
    };
    if (error) {
      const code = codeOf(error);
      if (code === 'PGRST202' || code === '42883') {
        return await fail(
          new Error(`${FN} is not in the database yet: the code is ahead of the migration`),
          { code },
        );
      }
      return await fail(new Error(`${FN} could not be read (${code ?? 'no code'})`), { code });
    }
    const read = readSecurityAlertList(data);
    if (!read.ok) {
      return await fail(new Error(`${FN} answered a shape this build does not know`), {
        where: read.where.slice(0, 80),
      });
    }
    if (read.refused !== null) {
      return await fail(new Error(`${FN} was refused (${read.refused})`), {
        refused: read.refused,
      });
    }
    const list = read.value;
    const emails = await actorEmails([...list.changes, ...list.latestChanges]);
    const withEmail = (c: SecurityAlertChange): SecurityAlertChangeView => ({
      ...c,
      actorEmail: emails.get(c.actorUserId) ?? null,
    });
    return {
      ok: true,
      view: {
        ...list,
        changes: list.changes.map(withEmail),
        latestChanges: list.latestChanges.map(withEmail),
      },
    };
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return await fail(new Error(timedOut ? `${FN} took too long` : `${FN} could not be read`), {
      code: timedOut ? 'timeout' : codeOf(err),
    });
  }
}
