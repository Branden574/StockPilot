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
      /try \{\s+if \(!\(await cacheCycleCount\(fetchedHeader, fetchedLines, fetchedUnder\)\)\) return 'discarded';\s+const fresh = await getCycleCount\(id\);\s+if \(fresh\) hydrateFromSnapshot\(fresh\);\s+\} catch \(e\) \{[\s\S]*?if \(!cached\) \{\s+setReadError\([^)]*\);\s+setEmptyState\('read-failed'\);/,
    );
  });
});

// B18 review of 254fb9c72: cacheCycleCount discards a fetch made for another
// cache, account or workspace and answers false, and the screen ignored the
// answer. With no copy on the phone it then showed a count with no lines, no
// message and no Retry (a count opened from a notification just after another
// account signed in: that account's first pull resets the cache while the
// fetch is out); with an older copy, it kept that one.
describe('cycle-count/[id].tsx: a fetch the cache discarded is loaded again once, then said', () => {
  it('loads the count again when cacheCycleCount answers false, once, and then shows the read failure with Retry', () => {
    expect(screen).toContain('const loadOnce = React.useCallback(async (): Promise<LoadPass> => {');
    expect(screen).toContain("type LoadPass = 'discarded' | undefined;");
    // A discarded store stops the pass before anything is read back or the
    // spinner is stopped (pinned above, in the store's try).
    expect(screen.match(/return 'discarded'/g)).toHaveLength(1);
    expect(screen).toMatch(
      /const load = React\.useCallback\(async \(\) => \{\s+if \(\(await loadOnce\(\)\) !== 'discarded'\) return;\s+if \(\(await loadOnce\(\)\) !== 'discarded'\) return;\s+setReadError\(COUNT_NOT_SAVED_AFTER_A_CHANGE\);\s+setEmptyState\('read-failed'\);\s+setLoading\(false\);\s+\}, \[loadOnce\]\);/,
    );
    // Two passes at most: the mount, the workspace change and both Retry
    // buttons go through load().
    expect(screen.match(/loadOnce\(\)/g)).toHaveLength(2);
    expect(screen.match(/void load\(\);/g)).toHaveLength(3);
    expect(screen).toContain('const COUNT_NOT_SAVED_AFTER_A_CHANGE =');
  });
});

// B18 reviews, 2026-10-25: a fetch that finished after a sign-out's wipe, a
// workspace switch's, or another account's sign-in wrote its count into the
// cache it no longer belonged to. The store is guarded by what the screen
// noted BEFORE the fetch (executed in cache-owner.sqlite.test.ts).
describe('cycle-count/[id].tsx: the count is stored only for the cache and account it was fetched for', () => {
  it('notes the cache and the account before the fetch is sent, and stores under that note', () => {
    const note = screen.indexOf('const fetchedUnder = await cacheWriteScope();');
    const fetch = screen.indexOf('fetchAllCycleCountLines(supabase, id)');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(fetch);
    expect(screen.match(/cacheCycleCount\(/g)).toHaveLength(1);
  });
});

// Simulator walk 2026-09-27: opening a posted count from the verification
// card showed "Reference unavailable / No single warehouse · 0/0 counted" and
// a Reassign button for 1 to 2 seconds before the count loaded. The header's
// words come from cycleCountHeaderView (tested in cycle-count-header.test.ts).
describe('cycle-count/[id].tsx: no facts and no open-count actions before the count is known', () => {
  it('the header is worded by cycleCountHeaderView, with a loading line', () => {
    expect(screen).toContain("from '@/lib/cycle-count-header'");
    expect(screen).toMatch(/const headerView = cycleCountHeaderView\(header, \{\s+loading,/);
    expect(screen).toContain("headerView.kind === 'loading'");
    expect(screen).toContain('{headerView.text}');
    // The old fallbacks that stated facts about a count not yet read.
    expect(screen).not.toContain("'No single warehouse'");
    expect(screen).not.toMatch(/\{countedCount\}\/\{lines\.length\} counted/);
  });

  it('a count still loading is not open (no Reassign, Release, Scan or edits)', () => {
    expect(screen).toContain('const isOpen = cycleCountIsOpen(header);');
    expect(screen).not.toContain("header?.status ?? 'in_progress'");
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
