import { describe, expect, it } from 'vitest';

import {
  type AuditRow,
  daysUntilExpiry,
  detectDeviceSpikes,
  detectExportAbuse,
  detectFailedLoginBursts,
  detectMassMutations,
  detectPasswordResetBursts,
  detectPrivilegeEscalations,
  isCertExpiringSoon,
} from './monitors';

// Shared audit-row factory for the Phase 2 anomaly detectors.
function auditRow(over: Partial<AuditRow> & { event: string }): AuditRow {
  return {
    event: over.event,
    user_id: over.user_id ?? null,
    organization_id: over.organization_id ?? null,
    ip: over.ip ?? null,
    metadata: over.metadata ?? null,
    created_at: over.created_at ?? '2026-06-24T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// daysUntilExpiry / isCertExpiringSoon
// ---------------------------------------------------------------------------

describe('daysUntilExpiry', () => {
  it('returns positive days when cert has not expired', () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const validTo = '2026-07-18T00:00:00Z'; // 30 days out
    expect(daysUntilExpiry(validTo, now)).toBe(30);
  });

  it('returns negative days when cert has already expired', () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const validTo = '2026-06-17T00:00:00Z'; // 1 day ago
    expect(daysUntilExpiry(validTo, now)).toBe(-1);
  });

  it('accepts a Date object as well as a string', () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const validTo = new Date('2026-06-28T00:00:00Z'); // 10 days out
    expect(daysUntilExpiry(validTo, now)).toBe(10);
  });
});

describe('isCertExpiringSoon', () => {
  const now = new Date('2026-06-18T00:00:00Z');

  it('returns true when cert expires in 10 days (< 30-day threshold)', () => {
    const validTo = '2026-06-28T00:00:00Z'; // 10 days out
    expect(isCertExpiringSoon(validTo, now)).toBe(true);
  });

  it('returns false when cert expires in 60 days (> 30-day threshold)', () => {
    const validTo = '2026-08-17T00:00:00Z'; // 60 days out
    expect(isCertExpiringSoon(validTo, now)).toBe(false);
  });

  it('returns true at the boundary: exactly 30 days away (≤ 30)', () => {
    const validTo = '2026-07-18T00:00:00Z'; // exactly 30 days
    expect(isCertExpiringSoon(validTo, now)).toBe(true);
  });

  it('returns false at 31 days away', () => {
    const validTo = '2026-07-19T00:00:00Z'; // 31 days out
    expect(isCertExpiringSoon(validTo, now)).toBe(false);
  });

  it('returns true for an already-expired cert (negative days)', () => {
    const validTo = '2026-06-01T00:00:00Z'; // in the past
    expect(isCertExpiringSoon(validTo, now)).toBe(true);
  });

  it('respects a custom threshold', () => {
    const validTo = '2026-07-25T00:00:00Z'; // 37 days out
    expect(isCertExpiringSoon(validTo, now, 14)).toBe(false);
    expect(isCertExpiringSoon(validTo, now, 60)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectDeviceSpikes
// ---------------------------------------------------------------------------

describe('detectDeviceSpikes', () => {
  const makeRow = (userId: string, ts: string, ip?: string) => ({
    user_id: userId,
    first_seen_at: ts,
    last_ip: ip ?? null,
  });

  it('returns empty array for empty input', () => {
    expect(detectDeviceSpikes([])).toEqual([]);
  });

  it('flags a user with ≥ threshold (4) new devices', () => {
    const rows = [
      makeRow('user-a', '2026-06-18T01:00:00Z', '1.1.1.1'),
      makeRow('user-a', '2026-06-18T02:00:00Z', '2.2.2.2'),
      makeRow('user-a', '2026-06-18T03:00:00Z', '3.3.3.3'),
      makeRow('user-a', '2026-06-18T04:00:00Z', '4.4.4.4'),
    ];
    const result = detectDeviceSpikes(rows, 4);
    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe('user-a');
    expect(result[0]!.newDeviceCount).toBe(4);
    // lastIp should be from the most recent row
    expect(result[0]!.lastIp).toBe('4.4.4.4');
  });

  it('ignores users below the threshold', () => {
    const rows = [
      makeRow('user-b', '2026-06-18T01:00:00Z'),
      makeRow('user-b', '2026-06-18T02:00:00Z'),
      makeRow('user-b', '2026-06-18T03:00:00Z'),
    ];
    // threshold 4 → user-b has only 3 → no spike
    expect(detectDeviceSpikes(rows, 4)).toEqual([]);
  });

  it('handles multiple users, only flagging those at/above threshold', () => {
    const rows = [
      // user-c: 5 rows → flagged
      makeRow('user-c', '2026-06-18T01:00:00Z', '10.0.0.1'),
      makeRow('user-c', '2026-06-18T02:00:00Z', '10.0.0.2'),
      makeRow('user-c', '2026-06-18T03:00:00Z', '10.0.0.3'),
      makeRow('user-c', '2026-06-18T04:00:00Z', '10.0.0.4'),
      makeRow('user-c', '2026-06-18T05:00:00Z', '10.0.0.5'),
      // user-d: 2 rows → not flagged
      makeRow('user-d', '2026-06-18T01:00:00Z', '9.9.9.9'),
      makeRow('user-d', '2026-06-18T02:00:00Z', '8.8.8.8'),
    ];
    const result = detectDeviceSpikes(rows, 4);
    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe('user-c');
    expect(result[0]!.newDeviceCount).toBe(5);
    expect(result[0]!.lastIp).toBe('10.0.0.5');
  });

  it('handles rows with null/undefined last_ip gracefully', () => {
    const rows = [
      { user_id: 'user-e', first_seen_at: '2026-06-18T01:00:00Z' },
      { user_id: 'user-e', first_seen_at: '2026-06-18T02:00:00Z', last_ip: null },
      { user_id: 'user-e', first_seen_at: '2026-06-18T03:00:00Z', last_ip: undefined },
      { user_id: 'user-e', first_seen_at: '2026-06-18T04:00:00Z', last_ip: null },
    ];
    const result = detectDeviceSpikes(rows, 4);
    expect(result).toHaveLength(1);
    expect(result[0]!.lastIp).toBeNull();
  });

  it('uses default threshold of 4 when none provided', () => {
    const rows = [
      makeRow('user-f', '2026-06-18T01:00:00Z'),
      makeRow('user-f', '2026-06-18T02:00:00Z'),
      makeRow('user-f', '2026-06-18T03:00:00Z'),
      makeRow('user-f', '2026-06-18T04:00:00Z'),
    ];
    // Default threshold is 4 — this should be flagged
    const result = detectDeviceSpikes(rows);
    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe('user-f');
  });
});

// ---------------------------------------------------------------------------
// detectFailedLoginBursts
// ---------------------------------------------------------------------------

describe('detectFailedLoginBursts', () => {
  const failed = (email: string, ip: string) =>
    auditRow({ event: 'user.sign_in_failed', ip, metadata: { email } });

  it('returns no findings for empty input', () => {
    expect(detectFailedLoginBursts([])).toEqual({ byEmail: [], byIp: [] });
  });

  it('flags an email at the threshold (≥8) and is case-insensitive', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      failed(i % 2 ? 'Victim@Org.com' : 'victim@org.com', `1.1.1.${i}`),
    );
    const { byEmail } = detectFailedLoginBursts(rows, { emailThreshold: 8, ipThreshold: 99 });
    expect(byEmail).toEqual([{ email: 'victim@org.com', count: 8 }]);
  });

  it('does not flag an email one below the threshold', () => {
    const rows = Array.from({ length: 7 }, (_, i) => failed('victim@org.com', `1.1.1.${i}`));
    expect(detectFailedLoginBursts(rows, { emailThreshold: 8 }).byEmail).toEqual([]);
  });

  it('flags an IP spraying many accounts (≥15) independent of per-email count', () => {
    const rows = Array.from({ length: 15 }, (_, i) => failed(`u${i}@org.com`, '9.9.9.9'));
    const { byEmail, byIp } = detectFailedLoginBursts(rows, { emailThreshold: 8, ipThreshold: 15 });
    expect(byEmail).toEqual([]); // each email only once
    expect(byIp).toEqual([{ ip: '9.9.9.9', count: 15 }]);
  });

  it('ignores non-login events mixed in', () => {
    const rows = [
      ...Array.from({ length: 8 }, () => failed('v@org.com', '2.2.2.2')),
      auditRow({ event: 'inventory.item.deleted', ip: '2.2.2.2' }),
    ];
    expect(detectFailedLoginBursts(rows, { emailThreshold: 8 }).byEmail[0]!.count).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// detectPasswordResetBursts
// ---------------------------------------------------------------------------

describe('detectPasswordResetBursts', () => {
  const reset = (email: string) =>
    auditRow({ event: 'user.password.reset_requested', metadata: { email } });

  it('flags an email at/above threshold and ignores other events', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => reset('target@org.com')),
      auditRow({ event: 'user.sign_in_failed', metadata: { email: 'target@org.com' } }),
    ];
    expect(detectPasswordResetBursts(rows, 5)).toEqual([{ email: 'target@org.com', count: 5 }]);
  });

  it('does not flag below threshold', () => {
    const rows = Array.from({ length: 4 }, () => reset('target@org.com'));
    expect(detectPasswordResetBursts(rows, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectPrivilegeEscalations
// ---------------------------------------------------------------------------

describe('detectPrivilegeEscalations', () => {
  const roleChange = (org: string, before: string, after: string) =>
    auditRow({ event: 'user.role.changed', organization_id: org, metadata: { before: { role: before }, after: { role: after } } });

  it('flags an org with ≥3 elevations to admin/owner', () => {
    const rows = [
      roleChange('org-1', 'staff', 'admin'),
      roleChange('org-1', 'manager', 'admin'),
      roleChange('org-1', 'viewer', 'owner'),
    ];
    expect(detectPrivilegeEscalations(rows, 3)).toEqual([{ organizationId: 'org-1', count: 3 }]);
  });

  it('ignores lateral moves and demotions (only true elevations to admin/owner count)', () => {
    const rows = [
      roleChange('org-2', 'owner', 'admin'), // demotion → not counted
      roleChange('org-2', 'staff', 'manager'), // elevation but not to admin/owner → not counted
      roleChange('org-2', 'admin', 'admin'), // no-op → not counted
      roleChange('org-2', 'staff', 'admin'), // 1 real elevation
    ];
    expect(detectPrivilegeEscalations(rows, 3)).toEqual([]);
  });

  it('does not flag below threshold', () => {
    const rows = [roleChange('org-3', 'staff', 'admin'), roleChange('org-3', 'staff', 'owner')];
    expect(detectPrivilegeEscalations(rows, 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectMassMutations
// ---------------------------------------------------------------------------

describe('detectMassMutations', () => {
  const del = (org: string, user: string) =>
    auditRow({ event: 'inventory.item.deleted', organization_id: org, user_id: user });
  const arch = (org: string, user: string) =>
    auditRow({ event: 'inventory.item.archived', organization_id: org, user_id: user });

  it('counts deletes + archives together, per (org,user)', () => {
    const rows = [
      ...Array.from({ length: 13 }, () => del('org-1', 'user-a')),
      ...Array.from({ length: 12 }, () => arch('org-1', 'user-a')),
    ];
    expect(detectMassMutations(rows, 25)).toEqual([
      { organizationId: 'org-1', userId: 'user-a', count: 25 },
    ]);
  });

  it('does not cross-contaminate different actors', () => {
    const rows = [
      ...Array.from({ length: 25 }, () => del('org-1', 'user-a')),
      ...Array.from({ length: 24 }, () => del('org-1', 'user-b')), // below threshold
    ];
    const result = detectMassMutations(rows, 25);
    expect(result).toEqual([{ organizationId: 'org-1', userId: 'user-a', count: 25 }]);
  });

  it('drops rows missing org or user', () => {
    const rows = [
      auditRow({ event: 'inventory.item.deleted', organization_id: 'org-1', user_id: null }),
      auditRow({ event: 'inventory.item.deleted', organization_id: null, user_id: 'user-a' }),
    ];
    expect(detectMassMutations(rows, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectExportAbuse
// ---------------------------------------------------------------------------

describe('detectExportAbuse', () => {
  const trip = (org: string, user: string) =>
    auditRow({ event: 'security.export_rate_limited', organization_id: org, user_id: user });

  it('flags an actor at/above threshold (≥3 trips)', () => {
    const rows = [trip('org-1', 'user-a'), trip('org-1', 'user-a'), trip('org-1', 'user-a')];
    expect(detectExportAbuse(rows, 3)).toEqual([
      { organizationId: 'org-1', userId: 'user-a', count: 3 },
    ]);
  });

  it('does not flag below threshold', () => {
    expect(detectExportAbuse([trip('org-1', 'user-a'), trip('org-1', 'user-a')], 3)).toEqual([]);
  });
});
