import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CACHED_CYCLE_COUNTS_LIST_SQL, CYCLE_COUNT_CACHE_HEADER_SQL } from './cycle-count-snapshot-sql';

/**
 * WIRING PINS for two offline cycle-count fixes. The cache module imports
 * expo-sqlite at the top level and cannot be loaded here (vitest.config.ts
 * collects src/** only, by design), so — as drain-rejection-wiring.test.ts
 * does — these read the real source and assert the property.
 *
 * SP-003: the assignee lock was DEAD on mobile. The detail screen receives
 * assigned_to from the API and computes isAssignee from header.assignedTo,
 * then caches the header and re-hydrates from getCycleCount() — which never
 * wrote or read assigned_to, so every non-assignee got editable inputs and
 * the assignee never saw Release. The column existed in db.ts all along.
 *
 * SP-021: every edit appended a fresh record_count row; a reordered retry
 * could land an older count after the correction. An edit now supersedes
 * earlier pending/failed rows for its line, and the drain sends only the
 * newest row per line.
 */

const cache = readFileSync(path.join(__dirname, 'cycle-count-cache.ts'), 'utf8');
const engine = readFileSync(path.join(__dirname, 'cycle-count-sync.ts'), 'utf8');

describe('assigned_to round-trips through the cache (SP-003)', () => {
  it('cacheCycleCount writes assigned_to from header.assignedTo', () => {
    // The statement itself lives in cycle-count-snapshot-sql.ts (so it runs
    // against a real SQLite in cycle-count-snapshot-sql.test.ts); the params
    // are still assembled here.
    expect(CYCLE_COUNT_CACHE_HEADER_SQL).toMatch(/insert or replace into cycle_counts[\s\S]*assigned_to/);
    const params = cache.slice(cache.indexOf('CYCLE_COUNT_CACHE_HEADER_SQL,'), cache.indexOf('for (const line of lines)'));
    expect(params).toMatch(/header\.assignedTo \?\? null/);
  });

  it('getCycleCount and listCachedCycleCounts select and map assigned_to', () => {
    // getCycleCount selects inline; listCachedCycleCounts runs the shared
    // CACHED_CYCLE_COUNTS_LIST_SQL (tested against a real SQLite).
    const selects = cache.match(/select id, organization_id, status, warehouse_id, warehouse_name,\s+started_at, posted_at, assigned_to, cached_at/g) ?? [];
    expect(selects.length, 'the detail header select must read assigned_to').toBe(1);
    expect(CACHED_CYCLE_COUNTS_LIST_SQL).toMatch(/cc\.assigned_to/);
    expect(cache).toMatch(/\}>\(CACHED_CYCLE_COUNTS_LIST_SQL\);/);
    const maps = cache.match(/assignedTo: (headerRow|r)\.assigned_to \?\? null/g) ?? [];
    expect(maps.length, 'both header mappers must expose assignedTo').toBe(2);
  });
});

describe('one live outbox row per line (SP-021)', () => {
  it('updateLocalLine supersedes earlier pending/failed rows for the same line inside the transaction', () => {
    const fn = cache.slice(cache.indexOf('export async function updateLocalLine'), cache.indexOf('export async function pendingCountFor'));
    const del = fn.indexOf('delete from pending_actions');
    const ins = fn.indexOf('insert into pending_actions');
    expect(del, 'supersede delete missing').toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
    const delStmt = fn.slice(del, ins);
    expect(delStmt).toMatch(/kind = 'record_count'/);
    expect(delStmt).toMatch(/status in \('pending','failed'\)/); // never a row in flight
    expect(delStmt).toMatch(/json_extract\(payload_json, '\$\.lineId'\) = \?/);
  });

  it('the drain sends only the newest row per line and acks the superseded ones', () => {
    expect(engine).toMatch(/import \{ latestRowsPerLine \} from '\.\/outbox-order'/);
    const drain = engine.slice(engine.indexOf('private async drainOutbox'), engine.indexOf('private async sendRecordCount'));
    expect(drain).toMatch(/latestRowsPerLine\(cycleRows\)/);
    // Superseded rows are settled only with an account signed in, and only
    // the live account's own are acked (another's are parked, outbox-scope.ts).
    expect(drain).toMatch(
      /for \(const stale of staleScope\.userId \? superseded : \[\]\)[\s\S]*?isOwnedBy\(stale, staleScope\.userId\)\) await outboxAck\(stale\.id\)/,
    );
    expect(drain).toMatch(/for \(const row of send\)/);
  });
});
