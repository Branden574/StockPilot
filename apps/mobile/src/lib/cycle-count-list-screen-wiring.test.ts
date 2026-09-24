import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Cycle counts screen (app/, not loadable under the node test runner) is
 * pinned by source text for the promises the brief makes about it. The logic
 * it is built from is exercised in cycle-count-history.test.ts.
 */
const screen = readFileSync(path.join(__dirname, '../../app/(drawer)/(tabs)/cycle-counts.tsx'), 'utf8');

describe('the cycle-count history screen', () => {
  it('reads the server list and never downloads count lines for progress', () => {
    expect(screen).toMatch(/listCycleCounts\(target, \{ summary: opts\.withSummary, signal: ctrl\.signal \}\)/);
    expect(screen).not.toMatch(/from\('cycle_count_lines'\)|cycle_count_lines \(/);
    expect(screen).not.toMatch(/\.from\('cycle_counts'\)/);
  });

  it('never treats a page on screen as a sync snapshot: no cache writes, no cleanup', () => {
    for (const writer of ['cacheCycleCount', 'CYCLE_COUNT_HEADER_UPSERT_SQL', 'STALE_CYCLE_COUNTS_DELETE_SQL', 'deleteOrgData', 'runAsync(']) {
      expect(screen).not.toContain(writer);
    }
  });

  it('drops a late or stale answer, but shows an error for a wrong-workspace answer to the newest request', () => {
    expect(screen).toMatch(/if \(!isCurrentListAnswer\(res, orgRef\.current, guard\.current\.isCurrent\(token\)\)\) \{/);
    expect(screen).toMatch(/if \(guard\.current\.isCurrent\(token\) && orgRef\.current === activeOrg\) \{\s*setPage\(null\);\s*setError\(/);
  });

  it('keeps the downloaded counts reachable under a failed read, labelled as downloaded', () => {
    expect(screen).toMatch(/const cached = await readDownloaded\(\);\s*if \(guard\.current\.isCurrent\(token\)\) setDownloaded\(cached\);/);
    expect(screen).toMatch(/const showingDownloaded = offline \|\| \(error !== null && downloaded !== null\);/);
    expect(screen).toContain("'Searching downloaded counts only'");
    expect(screen).toContain('Offline · searching downloaded counts only');
  });

  it('pages on the server only: Previous and Next never ask for an uncached page offline', () => {
    expect(screen).toMatch(/\{!showingDownloaded && page && page\.totalPages > 1 \? \(/);
  });

  it('keeps the view per workspace and reloads the SAME view on focus', () => {
    expect(screen).toMatch(/React\.useState<CycleCountListView>\(\(\) => recallListView\(orgId\)\)/);
    expect(screen).toMatch(/rememberListView\(orgId, view\)/);
    expect(screen).toMatch(/void load\(viewRef\.current, \{ withSummary: true \}\);/);
  });

  it('debounces typing by 250 ms and searches at once on submit', () => {
    expect(screen).toMatch(/const SEARCH_DEBOUNCE_MS = 250;/);
    expect(screen).toMatch(/onSubmitEditing=\{searchNow\}/);
  });
});

describe('cycle-counts list: "none downloaded" only after a successful read', () => {
  it('keeps a failed or skipped read as null, never an empty list', () => {
    expect(screen).not.toMatch(/setDownloaded\(cached \?\? \[\]\)/);
    expect(screen).toMatch(/const cached = await readDownloaded\(\);\s*if \(!guard\.current\.isCurrent\(token\)\) return;[\s\S]{0,200}setDownloaded\(cached\);/);
  });

  it('says "No counts are downloaded" under an error only when the store was read', () => {
    expect(screen).toMatch(/const empty = error \? \(\s*downloaded \? \(/);
  });

  it('the footer and the offline heading count downloads only when they were read', () => {
    expect(screen).toMatch(/const footerText = showingDownloaded\s*\?\s*downloaded\s*\?/);
    expect(screen).toMatch(/\? downloaded\s*\? `OFFLINE · \$\{downloaded\.length\} DOWNLOADED`\s*: 'OFFLINE'/);
  });
});
