import { describe, expect, it } from 'vitest';

import {
  daysUntilExpiry,
  detectDeviceSpikes,
  isCertExpiringSoon,
} from './monitors';

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
