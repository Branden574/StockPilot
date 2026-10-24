import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Movements screen (src/screens/movements.tsx) — WIRING PINS for L7.
 *
 * Owner decision Q1 (2026-10-05): movement times use the ORGANIZATION's time
 * zone on the phone and the web, like counts, exceptions and orders. This list
 * printed `new Date(created_at).toLocaleDateString(undefined, …)`, the device's
 * zone, so a movement near midnight showed a different day here than on the
 * count card. The screen cannot be rendered under vitest (it imports native
 * modules), so the source is pinned; the formatting itself is core's
 * formatMovementDay, tested in packages/core.
 */

const screen = readFileSync(path.resolve(__dirname, '../screens/movements.tsx'), 'utf8');

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const code = codeOnly(screen);

/** The screen's load callback, from its start to its dependency list. */
function loadBody(): string {
  const start = code.indexOf('const load = React.useCallback');
  const end = code.indexOf('}, [orgId]);', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe('Movements screen: the day in the organization zone (L7)', () => {
  it("reads the org's zone with the shared reader, beside the ledger read", () => {
    const load = loadBody();
    expect(load).toContain('readOrgTimeZone(supabase, orgId)');
    expect(load).toContain(".from('stock_movements')");
    expect(load).toMatch(/Promise\.all\(\[/);
  });

  it('keeps the zone already read through a failed refresh, and never another workspace\'s (#338 rule)', () => {
    expect(loadBody()).toContain('setKnownZone((prev) => nextKnownOrgZone(prev, orgId, zone));');
    expect(code).toContain('const timeZone = knownZoneFor(knownZone, orgId);');
    expect(code).not.toMatch(/setTimeZone\(zone\)/);
  });

  it("prints each row's day with core's formatter in that zone, never the device's", () => {
    expect(code).toContain('formatMovementDay(m.created_at, timeZone)');
    expect(code).toContain('timeZone={timeZone}');
    expect(code).not.toContain('toLocaleDateString(');
    expect(code).not.toContain('toLocaleString(');
  });
});
