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
 * The first fix kept the mirror but immediately ACKed the outbox row it
 * created. Re-pinned by the docket B10 review: the copy is now
 * `mirrorRecordedCount`, which writes the count and supersedes the line's older
 * queued counts in one transaction and queues NO row at all (proven on a real
 * SQLite in outbox-owner.sqlite.test.ts). The queued row's moment between the
 * write and the ack is gone, and so is the workspace it needed: since B10 the
 * outbox refuses to queue while the saved workspace is another account's, and
 * the scan then reported a count the server had saved as not saved.
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
  it('imports mirrorRecordedCount from the cycle-count cache, and not the offline edit path', () => {
    expect(confirmFn.length, 'onConfirm slice not found').toBeGreaterThan(0);
    const importBlock = screen.slice(
      screen.indexOf("from '@/lib/cycle-count-cache'") - 400,
      screen.indexOf("from '@/lib/cycle-count-cache'"),
    );
    expect(importBlock).toMatch(/\bmirrorRecordedCount\b/);
    expect(importBlock).not.toMatch(/\bupdateLocalLine\b|\boutboxAck\b/);
    expect(screen).not.toMatch(/\bupdateLocalLine\(|\boutboxAck\(/);
  });

  it('copies each line after the direct POST succeeded, for the account whose session sent it', () => {
    expect(confirmFn).toMatch(
      /if \(!res\.ok\) \{[\s\S]*?throw new Error\([\s\S]*?\}[\s\S]*?await mirrorRecordedCount\(w\.lineId, w\.count, session\.user\.id\);/,
    );
  });

  it('never queues a line on the confirm path', () => {
    // A queued copy is exactly the regression: forceSync replays it without
    // the aiScanId.
    expect(confirmFn).not.toMatch(/updateLocalLine\(|enqueue\(/);
  });
});
