import type { SupabaseClient } from '@supabase/supabase-js';

import type { ModuleId } from '@stockpilot/core';

import { effectiveModules } from './effective-modules';
import { ModulesUnavailableError } from './module-state';

/**
 * The ACCESS rule (see ./effective-modules) for ONE module, with a client the
 * caller already holds. It exists for paths that have no user context to
 * resolve a whole module set from: the public API-key path (on the
 * service-role client), the public webhook subscriptions, and the accounting
 * connect callbacks.
 *
 * THREE ANSWERS, and only two of them are booleans:
 *   - true: the module is on. An enabled row that was read, or a comp flag
 *     that was read as true. One read that grants is enough, whatever the
 *     other read did.
 *   - false: the module is off. BOTH reads answered and neither grants.
 *   - throws ModulesUnavailableError: a read did not answer and nothing that
 *     was read grants. The state is unknown, which is neither "on" nor "off"
 *     (supabase-js resolves a failed read as `{ data: null, error }`, the
 *     shape of "no row"). Each caller answers it as a retry: a 503, or the
 *     connect page's transient error code, never "not enabled".
 *
 * It never fails open: a read that did not answer grants nothing, and a
 * caller that forgets to catch gets an error, not a grant.
 *
 * WHAT COUNTS AS AN ANSWER. Each read is a list read bounded to one row (the
 * rule lib/auth/api-context.ts applies): a single-row read turns an empty
 * body into "no row" with no error. The rows read answers only as a list of
 * rows that each carry a boolean `enabled` (an empty list is "no row", which
 * is off). The comp read answers only as one organization row with a boolean
 * flag (the column is NOT NULL): no row is a flag that was never seen.
 *
 * NOT for automation (crons, exports, emails, webhooks, public links): those
 * need the explicit enabled row and must keep reading it directly.
 */
export async function orgMayUseModule(
  client: Pick<SupabaseClient, 'from'>,
  organizationId: string,
  moduleId: ModuleId,
): Promise<boolean> {
  const [row, org] = await Promise.all([
    client
      .from('organization_modules')
      .select('enabled')
      .eq('organization_id', organizationId)
      .eq('module_id', moduleId)
      .limit(1),
    client.from('organizations').select('all_modules_comp').eq('id', organizationId).limit(1),
  ]);

  const rows = row.data as unknown;
  const rowAnswered =
    !row.error &&
    Array.isArray(rows) &&
    rows.every(
      (r) => r && typeof r === 'object' && typeof (r as { enabled?: unknown }).enabled === 'boolean',
    );
  const enabled = rowAnswered && (rows as Array<{ enabled: boolean }>)[0]?.enabled === true;

  const orgRows = org.data as unknown;
  const compAnswered =
    !org.error &&
    Array.isArray(orgRows) &&
    orgRows.length === 1 &&
    Boolean(orgRows[0]) &&
    typeof orgRows[0] === 'object' &&
    typeof (orgRows[0] as { all_modules_comp?: unknown }).all_modules_comp === 'boolean';
  const comped =
    compAnswered && (orgRows as Array<{ all_modules_comp: boolean }>)[0]!.all_modules_comp === true;

  if (effectiveModules(enabled ? [{ module_id: moduleId }] : [], comped).has(moduleId)) return true;
  if (rowAnswered && compAnswered) return false;
  // Codes only: a message can quote request details.
  console.error(
    '[orgMayUseModule] module state unreadable:',
    moduleId,
    rowAnswered ? 'rows read' : `rows ${row.error?.code || 'not an answer'}`,
    compAnswered ? 'comp read' : `comp ${org.error?.code || 'not an answer'}`,
  );
  throw new ModulesUnavailableError();
}
