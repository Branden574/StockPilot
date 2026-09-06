import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WIRING PINS for SP-036 — the AI Shelf Scan confirm double-wrote every line.
 *
 * `app/cycle-count/ai-scan/[id].tsx` imports expo-camera / expo-file-system at
 * the top level and vitest.config.ts deliberately collects `src/**` only, so —
 * exactly as cycle-count-cache-wiring.test.ts and drain-rejection-wiring.test.ts
 * do — these read the real screen source and assert the property.
 *
 * The bug: after the direct `POST .../record` (which carries `aiScanId`)
 * succeeded, the screen called `updateLocalLine` to mirror the count locally.
 * But `updateLocalLine` is the OFFLINE edit path — it also sets local_dirty=1
 * and enqueues a `record_count` outbox row whose payload has no aiScanId. The
 * confirm then calls `forceSync()`, which replayed every one of those rows
 * against the same route; the route maps a missing aiScanId to NULL, so the
 * replay wiped the ai_scan_id the direct write had just set (the audit link
 * from the count back to the scan photo), and the doubled volume (N direct +
 * N replays) tripped the route's 120/min per-user rate limit on a large scan.
 *
 * The fix keeps the mirror but immediately ACKs the outbox row it created —
 * `outboxAck` is precisely the "the server already has this" bookkeeping
 * (delete the row + clear local_dirty, in one transaction).
 */

const screen = readFileSync(
  path.join(__dirname, '..', '..', 'app', 'cycle-count', 'ai-scan', '[id].tsx'),
  'utf8',
);

const confirmFn = screen.slice(
  screen.indexOf('async function onConfirm()'),
  screen.indexOf('// ─── Render branches'),
);

describe('AI scan confirm leaves no replayable outbox row (SP-036)', () => {
  it('imports outboxAck from the cycle-count cache', () => {
    expect(confirmFn.length, 'onConfirm slice not found').toBeGreaterThan(0);
    const importBlock = screen.slice(
      screen.indexOf("from '@/lib/cycle-count-cache'") - 400,
      screen.indexOf("from '@/lib/cycle-count-cache'"),
    );
    expect(importBlock).toMatch(/\boutboxAck\b/);
  });

  it('acks the outbox row that the local mirror created, after the direct POST', () => {
    const mirror = confirmFn.indexOf('updateLocalLine(');
    const ack = confirmFn.indexOf('outboxAck(');
    expect(mirror, 'the local mirror write must still happen').toBeGreaterThan(-1);
    expect(ack, 'the mirror’s outbox row must be acked').toBeGreaterThan(-1);
    // Order matters: mirror first (it is what creates the row), ack second.
    expect(ack).toBeGreaterThan(mirror);
    // …and the ack must target THAT row's id, not some unrelated value.
    expect(confirmFn).toMatch(
      /(?:const|let)\s+(\w+)\s*=\s*await\s+updateLocalLine\(\s*w\.lineId,\s*w\.count\s*\);[\s\S]{0,200}?outboxAck\(\s*\1\.outboxId\s*\)/,
    );
  });

  it('never leaves a bare un-acked updateLocalLine on the confirm path', () => {
    // A bare `await updateLocalLine(...)` whose result is discarded is exactly
    // the regression: the outbox row it enqueues gets replayed by forceSync.
    expect(confirmFn).not.toMatch(/^\s*await updateLocalLine\(/m);
  });
});
