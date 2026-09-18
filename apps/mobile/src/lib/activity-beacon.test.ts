import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const orgHeader = vi.fn();
vi.mock('./api', () => ({
  api: (...a: unknown[]) => api(...a),
  orgHeader: () => orgHeader(),
}));

import {
  BEACON_MIN_INTERVAL_MS,
  isSeenReportDue,
  reportSeen,
  resetSeenBeaconForTests,
} from './activity-beacon';

/**
 * Mobile "last seen" beacon. The contract that matters is the same as the web
 * one: person-driven, at most one report per five minutes per person per
 * workspace, silent on every failure, and nothing in the request that could
 * choose a user or a workspace beyond the header api() already sends.
 */

const T0 = 1_800_000_000_000;

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({ ok: true });
  orgHeader.mockReset();
  orgHeader.mockResolvedValue({ 'X-Organization-Id': 'org-1' });
  resetSeenBeaconForTests();
});

describe('isSeenReportDue', () => {
  it('is due when nothing was ever reported, and again from exactly five minutes on', () => {
    expect(isSeenReportDue(T0, undefined)).toBe(true);
    expect(isSeenReportDue(T0 + BEACON_MIN_INTERVAL_MS - 1, T0)).toBe(false);
    expect(isSeenReportDue(T0 + BEACON_MIN_INTERVAL_MS, T0)).toBe(true);
  });
});

describe('reportSeen', () => {
  it('posts to the beacon route with no body', async () => {
    await reportSeen('user-1', T0);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/v1/me/seen', { method: 'POST' });
  });

  it('sends one report for a burst, and another only after the interval', async () => {
    await Promise.all([reportSeen('user-1', T0), reportSeen('user-1', T0 + 5), reportSeen('user-1', T0 + 900)]);
    expect(api).toHaveBeenCalledTimes(1);
    await reportSeen('user-1', T0 + BEACON_MIN_INTERVAL_MS);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('throttles per person AND per workspace', async () => {
    await reportSeen('user-1', T0);
    orgHeader.mockResolvedValue({ 'X-Organization-Id': 'org-2' });
    await reportSeen('user-1', T0 + 10);
    orgHeader.mockResolvedValue({ 'X-Organization-Id': 'org-1' });
    await reportSeen('user-2', T0 + 20);
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('retries at the next moment when the request failed (offline on the floor)', async () => {
    api.mockRejectedValueOnce(new Error('Network request failed'));
    await reportSeen('user-1', T0);
    await reportSeen('user-1', T0 + 1000);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('never throws: not when the request fails, not when storage does', async () => {
    api.mockRejectedValue(new Error('boom'));
    await expect(reportSeen('user-1', T0)).resolves.toBeUndefined();
    orgHeader.mockRejectedValue(new Error('AsyncStorage unavailable'));
    await expect(reportSeen('user-1', T0 + 1)).resolves.toBeUndefined();
  });
});

/**
 * WIRING. The hook is three lines of React and is not rendered here (no native
 * runtime under vitest), so what is pinned is that the shell actually calls it,
 * with the signed-in user and a key that changes on navigation, and that the
 * hook has no timer.
 */
describe('wiring', () => {
  const layout = readFileSync(resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
  const hook = readFileSync(resolve(__dirname, './use-activity-beacon.ts'), 'utf8');

  it('the root layout drives the beacon from the session user and the route', () => {
    expect(layout).toContain("import { useActivityBeacon } from '@/lib/use-activity-beacon';");
    expect(layout).toMatch(/useActivityBeacon\(\s*session\?\.user\?\.id \?\? null,\s*segments\.join\('\/'\)\s*\)/);
  });

  it('the hook listens for the foreground and has NO interval', () => {
    expect(hook).toContain("AppState.addEventListener('change'");
    expect(hook).toContain("state === 'active'");
    expect(hook).not.toMatch(/setInterval|setTimeout/);
  });
});
