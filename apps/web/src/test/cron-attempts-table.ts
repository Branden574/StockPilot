/**
 * An in-memory cron_sweep_attempts (0469) for route and helper tests: the
 * rows live here, every run in a test sees the writes of the others, and the
 * primary key (job, organization_id) refuses a second insert the way the
 * database does (23505). Spread `results` into makeSupabaseStub's map.
 *
 * It answers the chains cron-sweep.ts makes and throws on any other filter,
 * so a change of the claim's shape fails loudly instead of passing quietly:
 *   select: eq job, order, range (servedLikePostgrest);
 *   update: eq job, eq organization_id, lt last_attempt_at (as times), select;
 *   insert: one row; upsert: one row onto (job, organization_id).
 */

import { callArgs, servedLikePostgrest, type MockCall, type QueryResult } from './supabase-mock';

export interface CronAttemptRow {
  job: string;
  organization_id: string;
  last_attempt_at: string;
  consecutive_failures: number;
}

export function cronAttemptsTable(
  initial: CronAttemptRow[] = [],
  opts: { failRead?: () => boolean } = {},
) {
  const rows: CronAttemptRow[] = initial.map((r) => ({ ...r }));
  const find = (job: string, orgId: string) =>
    rows.find((r) => r.job === job && r.organization_id === orgId);
  const served = servedLikePostgrest(() => rows as unknown as Record<string, unknown>[]);

  const select = (call: MockCall): QueryResult => {
    if (opts.failRead?.()) return { data: null, error: { message: 'attempts read failed' } };
    return served(call);
  };

  const update = (call: MockCall): QueryResult => {
    const patch = callArgs(call, 'update')?.[0] as Partial<CronAttemptRow>;
    let hit = [...rows];
    call.methods.forEach((m, i) => {
      const [col, value] = (call.args[i] ?? []) as [keyof CronAttemptRow, unknown];
      if (m === 'update' || m === 'select') return;
      if (m === 'eq') hit = hit.filter((r) => r[col] === value);
      else if (m === 'lt' && col === 'last_attempt_at') {
        hit = hit.filter((r) => Date.parse(r.last_attempt_at) < Date.parse(String(value)));
      } else throw new Error(`cronAttemptsTable cannot evaluate .${m}(${String(col)}) on update`);
    });
    for (const r of hit) Object.assign(r, patch);
    return { data: hit.map((r) => ({ organization_id: r.organization_id })), error: null };
  };

  const insert = (call: MockCall): QueryResult => {
    if (call.methods[0] === 'upsert') {
      const row = call.args[0]?.[0] as Partial<CronAttemptRow> & {
        job: string;
        organization_id: string;
      };
      const existing = find(row.job, row.organization_id);
      if (existing) Object.assign(existing, row);
      else rows.push({ consecutive_failures: 0, ...row } as CronAttemptRow);
      return { data: null, error: null };
    }
    const row = call.args[0]?.[0] as CronAttemptRow;
    if (find(row.job, row.organization_id)) {
      return {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "cron_sweep_attempts_pkey"',
        },
      };
    }
    rows.push({ ...row, consecutive_failures: row.consecutive_failures ?? 0 });
    return { data: null, error: null };
  };

  return {
    rows,
    results: {
      'cron_sweep_attempts.select': select,
      'cron_sweep_attempts.update': update,
      'cron_sweep_attempts.insert': insert,
    },
  };
}
