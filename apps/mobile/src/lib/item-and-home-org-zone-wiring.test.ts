import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The phone's item screen and home screen — WIRING PINS for L7 (owner
 * decision Q1), slice 3 review F2.
 *
 * Movement times use the ORGANIZATION's time zone, like counts, exceptions,
 * orders and the phone's Movements list. The item screen's MOVEMENTS and
 * ACTIVITY cards (MovementCard, AuditCard) and the home screen's recent
 * movements printed `toLocaleString(undefined, …)` / `toLocaleTimeString`, the
 * device's zone, so with the zones apart one app showed two different times
 * for one movement. Neither screen can be rendered under vitest (native
 * modules at module scope), so the source is pinned; the formatting itself is
 * core's formatMovementCardWhen / formatMovementClock, tested in
 * packages/core.
 */

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const itemScreen = codeOnly(readFileSync(path.resolve(__dirname, '../../app/item/[id].tsx'), 'utf8'));
const home = codeOnly(readFileSync(path.resolve(__dirname, '../../app/(drawer)/(tabs)/index.tsx'), 'utf8'));

function fn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', at + 1);
  return src.slice(at, next === -1 ? undefined : next);
}

describe('item screen: MOVEMENTS and ACTIVITY in the organization zone (L7, F2)', () => {
  it("reads the org's zone ONCE with the shared reader, when a feed tab first shows", () => {
    expect(itemScreen.split('readOrgTimeZone(supabase, orgId)')).toHaveLength(2);
    const at = itemScreen.indexOf('readOrgTimeZone(supabase, orgId)');
    const effect = itemScreen.slice(itemScreen.lastIndexOf('React.useEffect(', at), at);
    expect(effect).toMatch(/feedTabShown/);
    expect(effect).toMatch(/zoneReadFor\.current === orgId/);
  });

  it("keeps the zone per organization, so a workspace switch never prints another organization's zone (#338 rule)", () => {
    expect(itemScreen).toContain('setKnownZone((prev) => nextKnownOrgZone(prev, orgId, zone));');
    expect(itemScreen).toContain('const orgTimeZone = knownZoneFor(knownZone, orgId);');
  });

  it('every movement and audit card is handed that zone', () => {
    const cards = itemScreen.match(/<MovementCard\b[\s\S]*?\/>/g) ?? [];
    expect(cards.length).toBe(2);
    for (const card of cards) expect(card).toContain('timeZone={orgTimeZone}');
    expect(itemScreen).toContain('<AuditCard key={entry.id} audit={entry.audit} timeZone={orgTimeZone} />');
  });

  it("formats with core's org-zone formatter, never the device zone", () => {
    expect(fn(itemScreen, 'MovementCard')).toContain('formatMovementCardWhen(movement.created_at, timeZone)');
    expect(fn(itemScreen, 'AuditCard')).toContain('formatMovementCardWhen(audit.createdAt, timeZone)');
    for (const name of ['MovementCard', 'AuditCard']) {
      expect(fn(itemScreen, name), name).not.toMatch(/toLocale(String|DateString|TimeString)\(/);
    }
  });
});

describe('home screen: recent movements in the organization zone (L7, F2)', () => {
  it("reads the org's zone with the shared reader, beside the dashboard reads", () => {
    const start = home.indexOf('const load = React.useCallback');
    const end = home.indexOf('}, [user, activeOrgId]);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const load = home.slice(start, end);
    expect(load).toContain('readOrgTimeZone(supabase, orgId)');
    expect(load).toContain(".from('stock_movements')");
    // A failed read on a refresh keeps the zone already read (#338 rule).
    expect(load).toContain('setKnownZone((prev) => nextKnownOrgZone(prev, orgId, zone));');
    expect(home).toContain('const timeZone = knownZoneFor(knownZone, activeOrgId);');
  });

  it("prints each row's time with core's formatter in that zone, never the device's", () => {
    const row = fn(home, 'MovementMiniRow');
    expect(row).toContain('formatMovementClock(m.createdAt, timeZone)');
    expect(row).not.toMatch(/toLocale(String|DateString|TimeString)\(/);
    expect(home).toMatch(/<MovementMiniRow[\s\S]*?timeZone=\{timeZone\}/);
  });
});
