import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AppearanceAccount } from './account';
import { FakeStorage } from './__fixtures__/fake-storage';
import { createAppearanceController } from './controller';
import { RECOVERY_ACTION_LABEL } from './labels';
import {
  RECOVERY_SAVE_WAIT_MS,
  isGlassShown,
  markCrashFallback,
  recoverToClassic,
  recoverToClassicInStorage,
} from './recovery';
import { PHONE_APPEARANCE_KEYS as KEYS } from './store';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

/**
 * Always able to switch back (plan 5.6, revision R13, item 39): the error
 * boundary's "Use classic design" and the one-time crash fallback, against
 * storage alone (the boundary must work when the appearance layer is what
 * threw). Offered whenever Liquid Glass is SHOWN, which under the 'default'
 * rollout includes a phone that never chose a Design.
 */

const NOW = Date.parse('2026-11-03T21:00:00Z');
const A = '6f1c2a9e-1b2c-4d3e-8f40-0a1b2c3d4e5f';
const device = (record: Record<string, unknown>) => JSON.stringify({ v: 2, ...record });
const sync = JSON.stringify({
  v: 2,
  userId: A,
  dirtyAxes: [],
  syncedAt: '2026-11-01T10:00:00Z',
});

describe('is Liquid Glass shown', () => {
  it.each([
    ['default, never chose', {}, 'default', true],
    ['default, chose Classic', { [KEYS.device]: device({ style: 'classic' }) }, 'default', false],
    ['default, chose a Theme only', { [KEYS.device]: device({ theme: 'dark' }) }, 'default', true],
    ['opt-in, never chose', {}, 'opt-in', false],
    [
      'opt-in, chose Liquid Glass',
      { [KEYS.device]: device({ style: 'liquid-glass' }) },
      'opt-in',
      true,
    ],
    ['off, chose Liquid Glass', { [KEYS.device]: device({ style: 'liquid-glass' }) }, 'off', false],
  ] as const)('%s -> %s', async (_name, seed, rollout, expected) => {
    expect(await isGlassShown(new FakeStorage(seed), rollout, NOW)).toBe(expected);
  });

  it('the live controller’s answer wins when it has one (this launch is in the crash fallback)', async () => {
    const storage = new FakeStorage({ [KEYS.device]: device({ style: 'liquid-glass' }) });
    expect(await isGlassShown(storage, 'default', NOW, 'classic')).toBe(false);
    expect(await isGlassShown(new FakeStorage(), 'opt-in', NOW, 'liquid-glass')).toBe(true);
  });
});

describe('the crash fallback flag', () => {
  it('is set after a crash only when Liquid Glass is shown', async () => {
    const glass = new FakeStorage();
    expect(await markCrashFallback(glass, 'default', NOW)).toBe(true);
    expect(glass.data.get(KEYS.fallback)).toBe('1');
    // Nothing stored is changed: a passing fault never switches anyone for good.
    expect(glass.data.has(KEYS.device)).toBe(false);

    const classic = new FakeStorage({ [KEYS.device]: device({ style: 'classic' }) });
    expect(await markCrashFallback(classic, 'default', NOW)).toBe(false);
    expect(classic.data.has(KEYS.fallback)).toBe(false);

    const off = new FakeStorage({ [KEYS.device]: device({ style: 'liquid-glass' }) });
    expect(await markCrashFallback(off, 'off', NOW)).toBe(false);
    expect(off.data.has(KEYS.fallback)).toBe(false);
  });
});

describe('"Use classic design"', () => {
  it('sets the Design to Classic, keeps the Theme, and owes the account a save of the Design', async () => {
    const storage = new FakeStorage({
      [KEYS.device]: device({ style: 'liquid-glass', theme: 'dark' }),
      [KEYS.sync]: sync,
      [KEYS.fallback]: '1',
      'workspace.activeOrgId': 'org-1',
    });
    await recoverToClassicInStorage(storage, NOW);
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'classic', theme: 'dark' });
    expect(storage.json(KEYS.sync)).toMatchObject({ userId: A, dirtyAxes: ['style'] });
    expect(storage.data.has(KEYS.fallback)).toBe(false);
    expect([...storage.touched].sort()).toEqual([KEYS.device, KEYS.fallback, KEYS.sync].sort());
    expect(storage.data.get('workspace.activeOrgId')).toBe('org-1');
  });

  it('with no record at all (glass by default) it is Classic, the Theme left unset, and no sync record is invented', async () => {
    const storage = new FakeStorage();
    await recoverToClassicInStorage(storage, NOW);
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'classic' });
    expect(storage.data.has(KEYS.sync)).toBe(false);
  });

  it('after the reload the phone opens classic and saves the Design to the account', async () => {
    const storage = new FakeStorage({
      [KEYS.device]: device({ theme: 'dark' }),
      [KEYS.sync]: sync,
    });
    await recoverToClassicInStorage(storage, NOW);
    const saves: unknown[] = [];
    const controller = createAppearanceController({
      storage,
      account: {
        fetch: async () => ({ ok: true, row: null }),
        save: async (_userId, axes) => {
          saves.push(axes);
          return {
            ok: true,
            row: { style: axes.style ?? null, theme: null, updated_at: '2026-11-03T21:00:00Z' },
          };
        },
      },
      now: () => NOW,
      rollout: 'default',
      holds: { isHeld: () => false, subscribe: () => () => undefined },
      peekSignedInUser: async () => null,
    });
    await controller.hydrate();
    expect(controller.getSnapshot()).toMatchObject({ style: 'classic', theme: 'dark' });
    controller.setSession(A);
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toEqual([{ style: 'classic' }]);
    expect(controller.getSnapshot().state.status).toBe('synced');
  });
});

/**
 * The account row on a fake server, and a phone runtime that the reload cuts:
 * a save lands on the server only if its request completes before the reload
 * (Updates.reloadAsync() tears the JavaScript and its requests down).
 */
function serverAndRuntime() {
  const server: { row: Record<string, unknown> | null; at: number } = { row: null, at: 0 };
  const stamp = () => `2026-11-03T21:00:${String(++server.at).padStart(2, '0')}Z`;
  const runtime = (opts: { saveAnswers?: boolean } = {}) => {
    let cut = false;
    const account: AppearanceAccount = {
      fetch: async () => ({ ok: true, row: server.row }),
      save: (_userId, axes) =>
        new Promise((resolve) => {
          if (opts.saveAnswers === false) return; // a captive portal: never answers
          setTimeout(() => {
            if (cut) return;
            server.row = {
              style: (server.row?.style as string | null | undefined) ?? null,
              theme: (server.row?.theme as string | null | undefined) ?? null,
              ...axes,
              updated_at: stamp(),
            };
            resolve({ ok: true, row: server.row });
          }, 0);
        }),
    };
    return { account, reload: () => (cut = true) };
  };
  return { server, stamp, runtime };
}

const noHolds = { isHeld: () => false, subscribe: () => () => undefined };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('"Use classic design" holds the reload until the account has the Design (or the cap)', () => {
  it('no row at the last read, Keep Liquid Glass on the web since, glass crashes: Classic after the reload, and in the row', async () => {
    const { server, stamp, runtime } = serverAndRuntime();
    const storage = new FakeStorage();
    const before = runtime();
    const live = createAppearanceController({
      storage,
      account: before.account,
      now: () => NOW,
      rollout: 'default',
      holds: noHolds,
      peekSignedInUser: async () => A,
    });
    await live.hydrate();
    await tick();
    await live.flush();
    // The last read found no row: synced with nothing, syncedAt null.
    expect(storage.json(KEYS.sync)).toEqual({ v: 2, userId: A, dirtyAxes: [], syncedAt: null });
    // Then the web: "Keep Liquid Glass".
    server.row = { style: 'liquid-glass', theme: null, updated_at: stamp() };

    // Glass crashes on the phone; the person presses "Use classic design".
    await recoverToClassic(storage, NOW, live);
    before.reload();

    const after = createAppearanceController({
      storage,
      account: runtime().account,
      now: () => NOW,
      rollout: 'default',
      holds: noHolds,
      peekSignedInUser: async () => A,
    });
    await after.hydrate();
    expect(after.getSnapshot().style).toBe('classic');
    after.setSession(A);
    await tick();
    await after.flush();
    expect(after.getSnapshot().style).toBe('classic');
    expect(server.row).toMatchObject({ style: 'classic' });
  });

  it('a save that never answers (a captive portal) holds the reload no longer than the cap, and the phone still opens classic', async () => {
    const { runtime } = serverAndRuntime();
    const storage = new FakeStorage({ [KEYS.sync]: sync });
    const before = runtime({ saveAnswers: false });
    const live = createAppearanceController({
      storage,
      account: before.account,
      now: () => NOW,
      rollout: 'default',
      holds: noHolds,
      peekSignedInUser: async () => null,
    });
    await live.hydrate();
    live.setSession(A);
    await tick();
    const waits: number[] = [];
    await recoverToClassic(storage, NOW, live, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([RECOVERY_SAVE_WAIT_MS]);
    expect(RECOVERY_SAVE_WAIT_MS).toBeLessThanOrEqual(3000);
    expect(storage.json(KEYS.device)).toEqual({ v: 2, style: 'classic' });
  });

  it('with no live controller it is storage alone, and it never throws', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    await expect(recoverToClassic(storage, NOW, null)).resolves.toBeUndefined();
    const ok = new FakeStorage();
    await recoverToClassic(ok, NOW, null);
    expect(ok.json(KEYS.device)).toEqual({ v: 2, style: 'classic' });
  });
});

describe('the error boundary offers the way back only while Liquid Glass is shown', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../components/error-boundary.tsx'),
    'utf8',
  ).replace(/\s+/g, ' ');

  it('shows the action under `this.state.glass`, which only storage and the live look set, after the crash is reported', () => {
    expect(RECOVERY_ACTION_LABEL).toBe('Use classic design');
    expect(src).toContain('{this.state.glass ? ( <Pressable');
    expect(src).toContain('{RECOVERY_ACTION_LABEL}');
    expect(src).toContain('state: State = { error: null, glass: false };');
    expect(src).toContain('return { error, glass: false };');
    expect(src).toContain(
      'void markCrashFallback(asyncStorageAppearance, glassRollout(), Date.now(), drawnStyle())',
    );
    expect(src).toContain('.then((glass) => { if (glass) this.setState({ glass: true }); })');
    // The action goes at once, then the Design reaches storage and the account
    // (the save waited for, capped), and only then the reload.
    expect(src).toContain(
      'this.setState({ glass: false }); await recoverToClassic(asyncStorageAppearance, Date.now(), peekAppearanceController()); await this.handleReload();',
    );
    expect(src).toContain("tags: { appearance: drawnStyle() ?? 'unknown' },");
  });

  it('never reads the provider or a hook: storage and the controller, if it still answers', () => {
    for (const leak of [
      'useAppearance',
      'appearance/provider',
      'appearance/context',
      'useContext',
    ]) {
      expect(src, leak).not.toContain(leak);
    }
    expect(src).toContain('peekAppearanceController()');
  });
});
