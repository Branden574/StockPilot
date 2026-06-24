/**
 * Pure, side-effect-free helpers used by the cybersecurity monitoring crons.
 * Kept in a separate module so they can be unit-tested without any I/O.
 */

/**
 * Whole days (floored) from now until `validTo`. Returns a negative number
 * when the cert has already expired.
 */
export function daysUntilExpiry(validTo: string | Date, now: Date): number {
  const expiryMs =
    typeof validTo === 'string' ? new Date(validTo).getTime() : validTo.getTime();
  const diffMs = expiryMs - now.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Returns true when a TLS certificate is expiring within `thresholdDays`
 * (inclusive) or has already expired.
 */
export function isCertExpiringSoon(
  validTo: string | Date,
  now: Date,
  thresholdDays = 30,
): boolean {
  return daysUntilExpiry(validTo, now) <= thresholdDays;
}

export interface DeviceRow {
  user_id: string;
  first_seen_at: string;
  last_ip?: string | null;
}

export interface DeviceSpike {
  userId: string;
  newDeviceCount: number;
  lastIp: string | null;
}

/**
 * Groups `rows` by user_id and returns entries where the count of distinct
 * rows is at or above `threshold`. `lastIp` is taken from the most recently
 * added row for that user.
 */
export function detectDeviceSpikes(
  rows: DeviceRow[],
  threshold = 4,
): DeviceSpike[] {
  const byUser = new Map<string, { count: number; lastIp: string | null; latestTs: string }>();

  for (const row of rows) {
    const existing = byUser.get(row.user_id);
    if (!existing) {
      byUser.set(row.user_id, {
        count: 1,
        lastIp: row.last_ip ?? null,
        latestTs: row.first_seen_at,
      });
    } else {
      existing.count += 1;
      // Keep the IP from the most recent first_seen_at
      if (row.first_seen_at >= existing.latestTs) {
        existing.latestTs = row.first_seen_at;
        existing.lastIp = row.last_ip ?? null;
      }
    }
  }

  const spikes: DeviceSpike[] = [];
  for (const [userId, { count, lastIp }] of byUser.entries()) {
    if (count >= threshold) {
      spikes.push({ userId, newDeviceCount: count, lastIp });
    }
  }
  return spikes;
}

// ─── Audit-log anomaly detectors (Cybersecurity Phase 2) ──────────────────────
//
// All take pre-filtered `audit_logs` rows (the cron pulls the relevant events
// within the look-back window) and return the findings worth alerting on. Pure
// + side-effect-free so they unit-test without any I/O, like detectDeviceSpikes.

/** Minimal shape of an `audit_logs` row the detectors read. */
export interface AuditRow {
  event: string;
  user_id: string | null;
  organization_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Role privilege ranks — used to tell an elevation from a lateral/demotion. */
const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  staff: 2,
  manager: 3,
  admin: 4,
  owner: 5,
};
const ELEVATED_ROLES = new Set(['admin', 'owner']);

/** Counts rows by a string key, dropping rows whose key is null/empty. */
function countByKey(rows: AuditRow[], keyOf: (r: AuditRow) => string | null | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function metaString(row: AuditRow, key: string): string | null {
  const v = row.metadata?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface FailedLoginBursts {
  byEmail: Array<{ email: string; count: number }>;
  byIp: Array<{ ip: string; count: number }>;
}

/**
 * Flags brute-force / credential-stuffing: an email or source IP that produced
 * a burst of `user.sign_in_failed` events in the window. Grouped two ways
 * because a single attacker can spray many accounts from one IP, or hammer one
 * account from rotating IPs.
 */
export function detectFailedLoginBursts(
  rows: AuditRow[],
  opts: { emailThreshold?: number; ipThreshold?: number } = {},
): FailedLoginBursts {
  const emailThreshold = opts.emailThreshold ?? 8;
  const ipThreshold = opts.ipThreshold ?? 15;
  const failed = rows.filter((r) => r.event === 'user.sign_in_failed');

  const byEmail = [...countByKey(failed, (r) => metaString(r, 'email')?.toLowerCase()).entries()]
    .filter(([, count]) => count >= emailThreshold)
    .map(([email, count]) => ({ email, count }));
  const byIp = [...countByKey(failed, (r) => r.ip).entries()]
    .filter(([, count]) => count >= ipThreshold)
    .map(([ip, count]) => ({ ip, count }));

  return { byEmail, byIp };
}

/**
 * Flags account-takeover recon: an email that triggered a burst of
 * `user.password.reset_requested` events in the window.
 */
export function detectPasswordResetBursts(
  rows: AuditRow[],
  threshold = 5,
): Array<{ email: string; count: number }> {
  const resets = rows.filter((r) => r.event === 'user.password.reset_requested');
  return [...countByKey(resets, (r) => metaString(r, 'email')?.toLowerCase()).entries()]
    .filter(([, count]) => count >= threshold)
    .map(([email, count]) => ({ email, count }));
}

/**
 * Flags an org with a burst of role ELEVATIONS to admin/owner — a compromised
 * account or insider granting access. Only true elevations count: the new role
 * must be admin/owner AND outrank the prior role (a lateral move or a demotion
 * like owner→admin is ignored).
 */
export function detectPrivilegeEscalations(
  rows: AuditRow[],
  threshold = 3,
): Array<{ organizationId: string; count: number }> {
  const elevations = rows.filter((r) => {
    if (r.event !== 'user.role.changed') return false;
    const after = (r.metadata?.after as { role?: string } | undefined)?.role;
    const before = (r.metadata?.before as { role?: string } | undefined)?.role;
    if (!after || !ELEVATED_ROLES.has(after)) return false;
    // Elevation = new role strictly outranks the old (unknown old rank = 0).
    return (ROLE_RANK[after] ?? 0) > (ROLE_RANK[before ?? ''] ?? 0);
  });
  return [...countByKey(elevations, (r) => r.organization_id).entries()]
    .filter(([, count]) => count >= threshold)
    .map(([organizationId, count]) => ({ organizationId, count }));
}

/**
 * Flags a burst of item deletes/archives by one actor in one org — insider
 * threat, a compromised account wiping data, or a costly accidental mass action.
 */
export function detectMassMutations(
  rows: AuditRow[],
  threshold = 25,
): Array<{ organizationId: string; userId: string; count: number }> {
  const mutations = rows.filter(
    (r) => r.event === 'inventory.item.deleted' || r.event === 'inventory.item.archived',
  );
  return groupByOrgUser(mutations, threshold);
}

/**
 * Flags sustained export-abuse: one actor tripping the export rate-limit
 * repeatedly in the window (data-scraping attempt). Each trip already means the
 * user hit the export ceiling, so a low threshold is still high-signal.
 */
export function detectExportAbuse(
  rows: AuditRow[],
  threshold = 3,
): Array<{ organizationId: string; userId: string; count: number }> {
  const trips = rows.filter((r) => r.event === 'security.export_rate_limited');
  return groupByOrgUser(trips, threshold);
}

/** Shared (org,user) grouping + threshold used by the per-actor detectors. */
function groupByOrgUser(
  rows: AuditRow[],
  threshold: number,
): Array<{ organizationId: string; userId: string; count: number }> {
  const counts = new Map<string, { organizationId: string; userId: string; count: number }>();
  for (const r of rows) {
    if (!r.organization_id || !r.user_id) continue;
    const key = `${r.organization_id}::${r.user_id}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { organizationId: r.organization_id, userId: r.user_id, count: 1 });
  }
  return [...counts.values()].filter((c) => c.count >= threshold);
}
