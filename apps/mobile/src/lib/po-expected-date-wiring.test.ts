import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A purchase order's expected date is the DAY the buyer picked, stored as that
 * day's midnight UTC (the web PO form, both PO imports and this app's
 * normalizeExpectedAt). The Purchase orders and Receive POs screens printed it
 * with toLocaleDateString in the phone's zone, which in every US zone is the
 * evening before: "ETA Oct 9" for a purchase order expected Oct 10.
 * @stockpilot/core's formatCalendarDate reads the day back in UTC (its own
 * tests run it in Los Angeles, Sydney and through the Hermes stand-in); these
 * pins hold the screens, which vitest cannot load (native modules), to it.
 */

const ROOT = path.resolve(__dirname, '../..');
/** Source with comments stripped, so a comment cannot satisfy a pin. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const read = (rel: string) => codeOnly(readFileSync(path.join(ROOT, rel), 'utf8'));
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

describe("a purchase order's expected date on the phone", () => {
  // Mutation caught: the ETA printed through the device's zone again.
  it('the Purchase orders screen prints its ETA through formatCalendarDate', () => {
    const screen = read('src/screens/purchase-orders.tsx');
    expect(screen).toMatch(/import \{[^}]*\bformatCalendarDate\b[^}]*\} from '@stockpilot\/core';/);
    expect(screen).toContain('`ETA ${formatCalendarDate(po.expected_at)}`');
    expect(screen).not.toMatch(/new Date\(po\.expected_at\)/);
  });

  // Mutation caught: the Receive POs card's ETA printed through the device's zone again.
  it('the Receive POs screen prints its ETA through formatCalendarDate', () => {
    const screen = read('app/(drawer)/(tabs)/receive.tsx');
    expect(screen).toMatch(/import \{[^}]*\bformatCalendarDate\b[^}]*\} from '@stockpilot\/core';/);
    expect(screen).toContain('const etaText = formatCalendarDate(po.expected_at);');
    expect(screen).not.toMatch(/new Date\(po\.expected_at\)\.toLocale/);
  });

  // The sweep: no phone source prints an expected date through a zone, the
  // device's (toLocale*) or the organization's (formatOrgDate and friends).
  // On main it found the two screens above.
  it('no phone source prints an expected date in a time zone', () => {
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles(path.join(ROOT, 'app')),
      ...sourceFiles(path.join(ROOT, 'src')),
    ]) {
      const lines = codeOnlyKeepingLines(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (
          /new Date\([^)]*expected_?[aA]t[^)]*\)\s*\.\s*toLocale/.test(line) ||
          /formatOrg(Date|DateTime|Time)\([^)]*expected_?[aA]t/.test(line) ||
          /DateTimeFormat\([^)]*\)\.format\([^)]*expected_?[aA]t/.test(line)
        ) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
