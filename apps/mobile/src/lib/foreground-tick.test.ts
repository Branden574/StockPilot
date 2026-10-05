import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { foregroundTick } from './foreground-tick';

/**
 * L18a: offline, the rental detail's Try again flickered to a spinner every
 * 60 s. useSync's foreground timer called retryWorkspace on every tick, and a
 * retry publishes loading:true before it fails again offline. The tick now
 * retries the workspace only when the phone is online; a tapped Try again
 * still shows loading (it calls retryWorkspace itself).
 */
describe('foregroundTick', () => {
  function deps(online: boolean) {
    return {
      syncNow: vi.fn(async () => {}),
      retryWorkspace: vi.fn(async () => {}),
      isOnline: vi.fn(async () => online),
    };
  }

  it('offline: syncs (which skips itself offline) but does not retry the workspace', async () => {
    const d = deps(false);
    await foregroundTick(d);
    expect(d.syncNow).toHaveBeenCalledTimes(1);
    expect(d.retryWorkspace).not.toHaveBeenCalled();
  });

  it('online: syncs and retries the workspace', async () => {
    const d = deps(true);
    await foregroundTick(d);
    expect(d.syncNow).toHaveBeenCalledTimes(1);
    expect(d.retryWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe('useSync wiring (L18a)', () => {
  const src = readFileSync(path.resolve(__dirname, 'use-sync.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Mutation caught: the timer calling retryWorkspace directly again.
  it('the 60 s timer runs the tested tick, never retryWorkspace directly', () => {
    expect(src).toMatch(
      /interval = setInterval\(\(\) => \{\s*if \(cancelled\) return;\s*void foregroundTick\(\{ syncNow, retryWorkspace, isOnline \}\);\s*\}, FOREGROUND_INTERVAL_MS\);/,
    );
  });
});
