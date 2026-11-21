import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds, reportDegradedRead } from '@/server/services/lib/fetch-by-ids';

/**
 * The platform console's view of security events: the newest rows of every
 * organization, and the rows with no organization (scanner paths, automated
 * traffic on the public endpoints, unknown API keys, sign-in attempts for an
 * address that is no member's).
 *
 * Read with the service client: the table has row security with no policy,
 * and service_role may SELECT it (migration security_events). So this module
 * has no gate of its own, like platform/audit.ts: every caller is a platform
 * page that calls requirePlatformAdmin() first (test/page-step-up.guard.
 * test.ts rule 3), and that page is where the gate is tested.
 *
 * The columns are named, never `*`: the source hash and the row key are
 * never read (security-events.test.ts pins the list).
 */

export const PLATFORM_SECURITY_EVENT_COLUMNS =
  'id, minute, category, outcome, reason, source, organization_id, country, city, event_count, last_seen_at';

export const PLATFORM_SECURITY_EVENT_LIMIT = 200;

export interface PlatformSecurityEventRow {
  id: string;
  minute: string;
  lastSeenAt: string;
  category: string;
  outcome: string;
  reason: string;
  source: string;
  organizationId: string | null;
  /** The organization's name; null with no organization, or when it could not be read. */
  organizationName: string | null;
  country: string | null;
  city: string | null;
  count: number;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function countOf(v: unknown): number {
  const n = typeof v === 'string' && /^[0-9]{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** The newest rows across every organization and none, newest first. */
export async function listPlatformSecurityEvents(
  opts: { limit?: number } = {},
): Promise<PlatformSecurityEventRow[]> {
  const admin = createAdminClient();
  const limit = Math.min(Math.max(opts.limit ?? PLATFORM_SECURITY_EVENT_LIMIT, 1), 500);
  const { data, error } = await admin
    .from('security_events')
    .select(PLATFORM_SECURITY_EVENT_COLUMNS)
    .order('minute', { ascending: false })
    .order('last_seen_at', { ascending: false })
    .order('id')
    .limit(limit);
  if (error) throw new Error(`security_events read failed (${error.code ?? 'no code'})`);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const names = await organizationNames(admin, [
    ...new Set(rows.map((r) => text(r.organization_id)).filter((id): id is string => id !== null)),
  ]);

  return rows.flatMap((r) => {
    const id = text(r.id);
    const minute = text(r.minute);
    if (!id || !minute) return [];
    const organizationId = text(r.organization_id);
    return [
      {
        id,
        minute,
        lastSeenAt: text(r.last_seen_at) ?? minute,
        category: text(r.category) ?? '',
        outcome: text(r.outcome) ?? '',
        reason: text(r.reason) ?? '',
        source: text(r.source) ?? '',
        organizationId,
        organizationName: organizationId ? (names.get(organizationId) ?? null) : null,
        country: text(r.country),
        city: text(r.city),
        count: countOf(r.event_count),
      },
    ];
  });
}

/**
 * One batched read of the names, never one per row. A failure degrades to no
 * names (the page shows the organization's id), reported as a warning: a
 * label must never blank out the list itself.
 */
async function organizationNames(
  admin: ReturnType<typeof createAdminClient>,
  ids: string[],
): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  if (ids.length === 0) return byId;
  try {
    const data = await fetchAllRowsByIds<{ id?: unknown; name?: unknown }>(
      ids,
      (batch) => (from, to) =>
        admin.from('organizations').select('id, name').in('id', batch).order('id').range(from, to),
    );
    for (const row of data) {
      if (typeof row.id === 'string' && typeof row.name === 'string') byId.set(row.id, row.name);
    }
  } catch (err) {
    reportDegradedRead('platform-security-events.org-names', err, { count: ids.length });
  }
  return byId;
}
