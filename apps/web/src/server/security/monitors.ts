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
