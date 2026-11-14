import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * EVERY WEB LINK THE APP OPENS GOES THROUGH webLink (B124; web-links.test.ts
 * pins the addresses a production build opens).
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(MOBILE_ROOT, file), 'utf8');

const LINKS: [string, string][] = [
  ['app/rentals/[id].tsx', 'Linking.openURL(webLink(`/dashboard/rentals/${rental.id}`))'],
  ['app/(drawer)/settings.tsx', "Linking.openURL(webLink('/dashboard/settings/profile'))"],
  ['app/(drawer)/settings.tsx', "Linking.openURL(webLink('/dashboard/settings/security'))"],
  ['app/(drawer)/settings.tsx', "Linking.openURL(webLink('/privacy'))"],
  ['app/(drawer)/settings.tsx', "Linking.openURL(webLink('/terms'))"],
  ['app/item/[id].tsx', 'Linking.openURL(webLink(`/dashboard/inventory/${item.id}/edit`))'],
  ['src/screens/procedures.tsx', 'Linking.openURL(webLink(`/dashboard/procedures/${proc.id}`))'],
  ['app/(drawer)/schedule.tsx', "Linking.openURL(webLink('/dashboard/schedule'))"],
  ['src/screens/reports.tsx', "Linking.openURL(webLink('/dashboard/reports'))"],
];

describe('each link is built by webLink', () => {
  it.each(LINKS)('%s: %s', (file, call) => {
    const src = read(file).replace(/\s+/g, ' ');
    expect(src).toContain(call.replace(/\s+/g, ' '));
    expect(src).toContain("import { webLink } from '@/lib/web-links';");
  });

  it('settings.tsx opens Security from both of its rows', () => {
    const src = read('app/(drawer)/settings.tsx');
    expect(src.match(/webLink\('\/dashboard\/settings\/security'\)/g)).toHaveLength(2);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('no screen names the production host itself', () => {
  it('outside the fallback host and the push link check, no https://stockpilotusa.com in code', () => {
    // api-host.ts: the release fallback (PROD_API_FALLBACK). use-push-notifications.ts:
    // the hosts a push notification's link may name (it is checked, never built).
    const allowed = new Set(['src/lib/api-host.ts', 'src/lib/use-push-notifications.ts']);
    const offenders = [
      ...walk(path.join(MOBILE_ROOT, 'app')),
      ...walk(path.join(MOBILE_ROOT, 'src')),
    ]
      .filter((f) => !f.includes(`${path.sep}__fixtures__${path.sep}`))
      .map((f) => path.relative(MOBILE_ROOT, f).split(path.sep).join('/'))
      .filter((f) => !allowed.has(f))
      .filter((f) =>
        /https:\/\/(www\.)?stockpilotusa\.com/.test(
          read(f)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/^\s*\*.*$/gm, ''),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
