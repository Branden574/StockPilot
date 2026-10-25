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

function between(src: string, start: string, end: string): string {
  const at = src.indexOf(start);
  expect(at, `${start} not found`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, at + start.length);
  expect(stop, `${end} not found after ${start}`).toBeGreaterThan(at);
  return src.slice(at, stop);
}

describe('item screen: MOVEMENTS and ACTIVITY in the organization zone (L7, F2)', () => {
  // Slice 3 review (2026-10-24): the zone was read ONCE per screen, marked as
  // read before it answered and never unmarked, and pull-to-refresh did not
  // read it. One failed first read (offline) kept the cards in the default
  // zone for the screen's whole life. Nor was a late answer dropped, so a
  // workspace switch while the read was out could put the previous
  // workspace's zone in place of the current one's.
  it("reads the org's zone with the shared reader, through a newest-read (a late answer for the previous workspace never lands)", () => {
    expect(itemScreen.split('readOrgTimeZone(supabase, forOrg)')).toHaveLength(2);
    expect(itemScreen).toMatch(
      /const \[zoneRead\] = React\.useState\(\(\) =>\s*createNewestRead\(\s*\(forOrg: string\) => readOrgTimeZone\(supabase, forOrg\),\s*\(forOrg, zone\) => setKnownZone\(\(prev\) => nextKnownOrgZone\(prev, forOrg, zone\)\),\s*null,\s*\),\s*\);/,
    );
    // The read-once marker that was never cleared is gone.
    expect(itemScreen).not.toContain('zoneReadFor');
  });

  it("a feed tab reads the zone while this organization's zone is not known (a failed read included), never twice at once, and Overview never reads it", () => {
    expect(itemScreen).toContain("const feedTabShown = tab === 'movements' || tab === 'activity';");
    expect(itemScreen).toMatch(
      /React\.useEffect\(\(\) => \{\s*if \(!feedTabShown \|\| !orgId \|\| orgTimeZone !== null \|\| zoneRead\.pendingFor\(\) === orgId\) return;\s*void zoneRead\.read\(orgId\);\s*\}, \[feedTabShown, orgId, orgTimeZone, zoneRead\]\);/,
    );
  });

  it('pull-to-refresh on a feed tab reads the zone again, beside the item and the feed', () => {
    const refresh = between(itemScreen, 'async function onRefresh() {', '\n  }\n');
    expect(refresh).toContain('const zoneRefresh = feedTabShown && orgId ? zoneRead.read(orgId) : null;');
    expect(refresh).toContain('await zoneRefresh;');
    // Sent first, so it runs while the item and the feed load.
    expect(refresh.indexOf('zoneRead.read(orgId)')).toBeLessThan(refresh.indexOf('await load();'));
  });

  it("keeps the zone per organization, so a workspace switch never prints another organization's zone (#338 rule)", () => {
    expect(itemScreen).toContain('setKnownZone((prev) => nextKnownOrgZone(prev, forOrg, zone))');
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

  it("only the newest load lands: a late answer for the previous workspace never puts its figures, movements or zone on this one (slice 3 review, 2026-10-24)", () => {
    const start = home.indexOf('const load = React.useCallback');
    const load = home.slice(start, home.indexOf('}, [user, activeOrgId]);', start));
    expect(load).toContain('const seq = ++seqRef.current;');
    const guard = 'if (seq !== seqRef.current) return;';
    // After the reads, after the order and return lookups, and in the catch.
    expect(load.split(guard)).toHaveLength(4);
    const first = load.indexOf(guard);
    expect(first).toBeLessThan(load.indexOf('setKnownZone('));
    expect(first).toBeLessThan(load.indexOf('setSummary(homeSummary('));
    const afterLookups = load.indexOf(guard, load.indexOf(".from('returns')"));
    expect(afterLookups).toBeGreaterThan(-1);
    expect(afterLookups).toBeLessThan(load.indexOf('setRecent('));
    expect(load.indexOf(guard, load.indexOf('} catch {'))).toBeLessThan(load.indexOf('setSummary(null);'));
    expect(load).toContain('if (seq === seqRef.current) setLoading(false);');
  });

  it("prints each row's time with core's formatter in that zone, never the device's", () => {
    const row = fn(home, 'MovementMiniRow');
    expect(row).toContain('formatMovementClock(m.createdAt, timeZone)');
    expect(row).not.toMatch(/toLocale(String|DateString|TimeString)\(/);
    expect(home).toMatch(/<MovementMiniRow[\s\S]*?timeZone=\{timeZone\}/);
  });
});
