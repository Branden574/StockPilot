import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { utcDateLabel } from './utc-date-label';

describe('utcDateLabel', () => {
  it('formats in UTC whatever the server zone', () => {
    expect(utcDateLabel('2026-09-18T17:00:00Z')).toBe('Sep 18, 2026');
    // 23:30 Pacific on the 17th is the 18th in UTC.
    expect(utcDateLabel('2026-09-17T23:30:00-07:00')).toBe('Sep 18, 2026');
  });

  it('returns an empty string for anything that is not a date', () => {
    expect(utcDateLabel('nope')).toBe('');
  });
});

/**
 * Found in a real browser, invisible to every unit test: this helper used to be
 * exported from components/ui/local-date.tsx, which is 'use client'. The release
 * history pages are SERVER components and CALL it, and Next refuses to call a
 * function that lives in a client module ("Attempted to call utcDateLabel() from
 * the server"). The page tests render a server component as a plain function, so
 * they cannot see that boundary. This can.
 */
describe('server/client boundary', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

  it('this module carries no client directive', () => {
    expect(src('./utc-date-label.ts')).not.toMatch(/^\s*['"]use client['"]/m);
  });

  it('the release pages are server components and take the helper from here, not from a client module', () => {
    for (const page of [
      '../app/(dashboard)/dashboard/whats-new/page.tsx',
      '../app/(dashboard)/dashboard/whats-new/[slug]/page.tsx',
    ]) {
      const text = src(page);
      expect(text, page).not.toMatch(/^\s*['"]use client['"]/m);
      expect(text, page).toContain("import { utcDateLabel } from '@/lib/utc-date-label';");
      expect(text, page).not.toMatch(/import \{[^}]*utcDateLabel[^}]*\} from '@\/components\//);
    }
  });

  it('local-date.tsx exports components only, so nothing callable can be imported from it by a server page', () => {
    const text = src('../components/ui/local-date.tsx');
    expect(text).toMatch(/^\s*['"]use client['"]/m);
    const exported = [...text.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported).toEqual(['LocalDate']);
  });
});
