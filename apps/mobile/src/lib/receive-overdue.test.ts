import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The Receive POs screen's "N OPEN · M OVERDUE".
 *
 * A purchase order's expected date is a DAY, stored as that day's midnight
 * UTC. The screen counted a purchase order overdue when that stored midnight
 * was before the phone's clock, so in Los Angeles a purchase order expected
 * Oct 10 was "OVERDUE" from 5 PM on Oct 9, under a card that (since the
 * expected-date fix) says ETA Oct 10. The rule is the web's, from core
 * (isPastExpectedDay): overdue once the ORGANIZATION's date is after the
 * expected day. The organization's zone is read as the order screen reads it
 * (readOrgTimeZone); unset or unreadable, core uses its documented default.
 */

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';

const POS = [
  { expected_at: '2026-10-10T00:00:00.000Z' },
  { expected_at: '2026-10-12T00:00:00.000Z' },
  { expected_at: null },
];

/** Imported per test, so the screen pins below report on their own where the
 *  helper does not exist (origin/main). */
async function count(
  pos: readonly { expected_at: string | null }[],
  now: Date,
  timeZone: string | null,
): Promise<number> {
  const { receiveOverdueCount } = await import('./receive-overdue');
  return receiveOverdueCount(pos, now, timeZone);
}

describe('receiveOverdueCount', () => {
  const previousZone = process.env.TZ;
  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  it('Los Angeles: 0 on the evening before and on the expected day, 1 from the next day', async () => {
    for (const phoneZone of [LA, 'UTC', SYDNEY]) {
      process.env.TZ = phoneZone;
      const at = (iso: string) => count(POS, new Date(iso), LA);
      expect(await at('2026-10-10T00:30:00.000Z'), `Oct 9, 5:30 PM, phone in ${phoneZone}`).toBe(0);
      expect(await at('2026-10-10T19:00:00.000Z'), 'Oct 10, noon').toBe(0);
      expect(await at('2026-10-11T06:59:59.999Z'), 'Oct 10, 11:59 PM').toBe(0);
      expect(await at('2026-10-11T07:00:00.000Z'), 'Oct 11, 12:00 AM').toBe(1);
      expect(await at('2026-10-13T07:00:00.000Z'), 'Oct 13, 12:00 AM').toBe(2);
    }
  });

  it('Sydney: 0 at noon on the expected day, 1 from the next day', async () => {
    expect(await count(POS, new Date('2026-10-10T01:00:00.000Z'), SYDNEY)).toBe(0);
    expect(await count(POS, new Date('2026-10-10T13:00:00.000Z'), SYDNEY)).toBe(1);
  });

  it("an unread zone is core's documented default (Los Angeles)", async () => {
    expect(await count(POS, new Date('2026-10-10T00:30:00.000Z'), null)).toBe(0);
    expect(await count(POS, new Date('2026-10-11T07:00:00.000Z'), null)).toBe(1);
  });

  it('counts nothing for no purchase orders, or none with an expected date', async () => {
    expect(await count([], new Date('2026-10-20T00:00:00.000Z'), LA)).toBe(0);
    expect(await count([{ expected_at: null }], new Date('2026-10-20T00:00:00.000Z'), LA)).toBe(0);
  });
});

// ── The screen, which vitest cannot load (native modules) ─────────────────────

const ROOT = path.resolve(__dirname, '../..');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
/** codeOnly, but a block comment keeps its line breaks, so a reported line is the file's own. */
function codeOnlyKeepingLines(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__fixtures__') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('the Receive POs screen counts overdue by that rule, in the organization zone', () => {
  const screen = () => codeOnly(readFileSync(path.join(ROOT, 'app/(drawer)/(tabs)/receive.tsx'), 'utf8'));

  // Mutation caught: the count compares the stored midnight with the clock again.
  it('counts through receiveOverdueCount, with the zone the screen read', () => {
    const src = screen();
    // Review (2026-10-06): the screen also keeps its zone through nextKnownOrgZone.
    expect(src).toContain(
      "import { nextKnownOrgZone, receiveOverdueCount, type KnownOrgZone } from '@/lib/receive-overdue';",
    );
    expect(src).toContain('const overdueCount = receiveOverdueCount(pos, new Date(), timeZone);');
    expect(src).toContain("`${pos.length} OPEN${overdueCount > 0 ? ` · ${overdueCount} OVERDUE` : ''}`");
    expect(src).not.toMatch(/new Date\(p\.expected_at\)/);
  });

  // Mutation caught: the zone is not read, or not with the purchase orders (a
  // count in the default zone for an organization elsewhere).
  it("reads the organization's zone with the purchase orders, as the order screen does", () => {
    const src = screen();
    expect(src).toMatch(/import \{[^}]*\breadOrgTimeZone\b[^}]*\} from '@\/lib\/order-readiness';/);
    // Re-pinned by the review (2026-10-06; was: a plain timeZone state set
    // straight from the read): the zone is kept per organization, and a
    // failed read on a refresh keeps the zone already read.
    expect(src).toContain('const [knownZone, setKnownZone] = React.useState<KnownOrgZone | null>(null);');
    expect(src).toContain(
      'const timeZone = knownZone !== null && knownZone.orgId === orgId ? knownZone.zone : null;',
    );
    expect(src).toMatch(/await Promise\.all\(\[\s*supabase\s*\.from\('purchase_orders'\)/);
    expect(src).toContain('readOrgTimeZone(supabase, orgId),');
    expect(src).toContain('setKnownZone((prev) => nextKnownOrgZone(prev, orgId, zone));');
  });

  // The sweep: no phone source decides overdue or late by comparing an
  // expected date with an instant. On main it found receive.tsx's count.
  it('no phone source compares an expected date with an instant', () => {
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles(path.join(ROOT, 'app')),
      ...sourceFiles(path.join(ROOT, 'src')),
    ]) {
      const lines = codeOnlyKeepingLines(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (
          /new Date\([^)]*expected_?[aA]t[^)]*\)\s*(<|>|<=|>=)/.test(line) ||
          /(<|>|<=|>=)\s*new Date\([^)]*expected_?[aA]t/.test(line) ||
          /expected_?[aA]t(Ms)?\s*(<|>|<=|>=)\s*(now|Date\.now\(\))/.test(line)
        ) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

async function nextZone(
  ...args: Parameters<typeof import('./receive-overdue').nextKnownOrgZone>
): Promise<ReturnType<typeof import('./receive-overdue').nextKnownOrgZone>> {
  const { nextKnownOrgZone } = await import('./receive-overdue');
  return nextKnownOrgZone(...args);
}

describe('nextKnownOrgZone: a failed zone read on a refresh keeps the zone already read', () => {
  // Review (2026-10-06): readOrgTimeZone answers null for a refused or failed
  // read as for an unset zone, and the screen set the zone straight from it,
  // so a refresh whose zone read failed put a Sydney organization on the
  // default zone's day until the next good read.
  it('keeps the same organization\'s zone when a later read answers null', async () => {
    const first = await nextZone(null, 'org-a', 'Australia/Sydney');
    expect(first).toEqual({ orgId: 'org-a', zone: 'Australia/Sydney' });
    expect(await nextZone(first, 'org-a', null)).toEqual({ orgId: 'org-a', zone: 'Australia/Sydney' });
  });

  it('takes a new zone when the read answers one', async () => {
    const first = await nextZone(null, 'org-a', 'Australia/Sydney');
    expect(await nextZone(first, 'org-a', 'America/Los_Angeles')).toEqual({
      orgId: 'org-a',
      zone: 'America/Los_Angeles',
    });
  });

  it("never carries one organization's zone to another", async () => {
    const first = await nextZone(null, 'org-a', 'Australia/Sydney');
    expect(await nextZone(first, 'org-b', null)).toEqual({ orgId: 'org-b', zone: null });
    expect(await nextZone(first, 'org-b', 'UTC')).toEqual({ orgId: 'org-b', zone: 'UTC' });
  });

  it('the screen keeps its zone through nextKnownOrgZone', () => {
    const screen = readFileSync(path.resolve(__dirname, '../../app/(drawer)/(tabs)/receive.tsx'), 'utf8');
    expect(screen).toContain('setKnownZone((prev) => nextKnownOrgZone(prev, orgId, zone));');
    expect(screen).not.toContain('setTimeZone(zone)');
  });
});
