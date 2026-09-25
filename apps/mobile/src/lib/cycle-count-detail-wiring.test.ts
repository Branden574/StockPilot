import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for app/cycle-count/[id].tsx. The screen imports expo-router /
 * expo-network / expo-sqlite at the top level and vitest deliberately compiles
 * src/** only (vitest.config.ts), so — as count-picker-wiring.test.ts and
 * drain-rejection-wiring.test.ts do — these read the real source and assert the
 * load-bearing property.
 *
 * SP-032: the lines read was a single bare `.select()`, silently clamped to
 * PostgREST's `[api] max_rows = 1000`. A >1000-line count was only partially
 * countable on the phone and the truncated set was persisted to SQLite. It must
 * go through the paged fetcher.
 *
 * SP-055: posting called `supabase.rpc('post_cycle_count')` straight from the
 * device, bypassing the web service — so a mobile post applied variance but
 * wrote no `cycle_count.posted` audit row, fired no `cycle_count.completed`
 * webhook, skipped the cycle_counts module gate and skipped the warehouse
 * write-scope check. It must post through the Bearer API twin.
 */

const screen = readFileSync(
  path.resolve(__dirname, '../../app/cycle-count/[id].tsx'),
  'utf8',
);

describe('cycle-count/[id].tsx — lines read is paged (SP-032)', () => {
  it('reads lines through fetchAllCycleCountLines, not a bare select', () => {
    expect(screen).toContain("from '@/lib/cycle-count-lines-fetch'");
    expect(screen).toContain('fetchAllCycleCountLines(supabase, id)');
  });

  it('no longer builds an unbounded cycle_count_lines query inline', () => {
    expect(screen).not.toContain("from('cycle_count_lines')");
  });
});

describe('cycle-count/[id].tsx — post goes through the API twin (SP-055)', () => {
  it('calls postCycleCount() instead of the RPC', () => {
    expect(screen).toContain("from '@/lib/cycle-counts-api'");
    expect(screen).toContain('await postCycleCount(header.id)');
  });

  it('never calls the post_cycle_count RPC directly', () => {
    expect(screen).not.toContain("rpc('post_cycle_count'");
  });

  it('still maps a raw refusal code to a sentence as a fallback', () => {
    // The route returns already-mapped copy in `message`; the raw-code mapper
    // stays as the fallback for anything that reaches the device unmapped.
    expect(screen).toContain('postCycleCountErrorMessage(');
  });
});

describe('cycle-count/[id].tsx: a failed cache write is shown, not swallowed', () => {
  it('guards the store-then-read after the fetch and surfaces it when nothing is on screen', () => {
    expect(screen).toMatch(
      /try \{\s+await cacheCycleCount\(fetchedHeader, fetchedLines\);\s+const fresh = await getCycleCount\(id\);\s+if \(fresh\) hydrateFromSnapshot\(fresh\);\s+\} catch \(e\) \{[\s\S]*?if \(!cached\) \{\s+setReadError\([^)]*\);\s+setEmptyState\('read-failed'\);/,
    );
  });
});

describe('cycle-count/[id].tsx: an offline capture is shown in review (0369, D7)', () => {
  // The web review labels a line counted offline with when it was taken; a
  // manager reviewing and posting on the phone must see the same. Mutation:
  // drop the label, and the phone shows a stale capture as a fresh count.
  it('keeps the capture instant from the server row with the shared rule', () => {
    expect(screen).toContain('offlineCapturedAt: offlineCaptureAt({');
    expect(screen).toContain('captured_at: (r.captured_at as string | null | undefined) ?? null');
  });

  it('renders the shared label, in the organization\'s timezone, only for the server\'s count', () => {
    expect(screen).toContain('offlineCaptureLabel({ captured_at: l.offlineCapturedAt }, orgTimeZone)');
    expect(screen).toMatch(/l\.counted !== null && !l\.localDirty && !isDrafting/);
    expect(screen).toContain('{capturedText ? (');
  });
});
