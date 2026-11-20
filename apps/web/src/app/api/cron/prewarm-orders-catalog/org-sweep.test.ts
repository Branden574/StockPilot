import { describe, expect, it } from 'vitest';

import {
  KNOWN_HOT_ORG_IDS,
  ORG_SWEEP_CAP,
  ORG_SWEEP_SLOT_MS,
  ORG_SWEEP_WINDOW,
  planOrgSweep,
} from './org-sweep';

const orgs = (n: number) =>
  Array.from({ length: n }, (_, i) => `org-${String(i).padStart(4, '0')}`);
const none = new Map<string, number>();

describe('planOrgSweep', () => {
  it('seeds known-hot orgs FIRST, then the enumerated orgs, deduped', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1', 'hot-2'],
      // hot-2 also shows up mid-list from the enumeration — must not repeat.
      activeOrgIds: ['org-a', 'hot-2', 'org-b'],
      windowSize: 48,
      lastWarmed: none,
      now: 0,
    });
    expect(plan.orgIds).toEqual(['hot-1', 'hot-2', 'org-a', 'org-b']);
    expect(plan.windowOrgIds).toEqual(['org-a', 'org-b']);
    expect(plan).toMatchObject({ rotating: 2, outsideWindow: 0, runsToCoverAll: 1 });
  });

  it('with no more orgs than the window, every run takes all of them (as before)', () => {
    const active = orgs(48);
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1'],
      activeOrgIds: active,
      windowSize: 48,
      lastWarmed: new Map(active.map((id, i) => [id, 1_000 - i])),
      now: 0,
    });
    expect(plan.orgIds).toHaveLength(49);
    expect(new Set(plan.windowOrgIds)).toEqual(new Set(active));
    expect(plan.outsideWindow).toBe(0);
  });

  it('past the window, takes the never-warmed first (id order), then the least recently warmed', () => {
    const active = orgs(100);
    // org-0000..0049 warmed at times 50..99 (org-0049 most recently); the
    // rest never.
    const lastWarmed = new Map(active.slice(0, 50).map((id, i) => [id, 50 + i]));
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1'],
      activeOrgIds: active,
      windowSize: 48,
      lastWarmed,
      now: 0,
    });
    expect(plan.windowOrgIds).toEqual(active.slice(50, 98));
    expect(plan.orgIds).toEqual(['hot-1', ...active.slice(50, 98)]);
    expect(plan).toMatchObject({ rotating: 100, outsideWindow: 52, runsToCoverAll: 3 });
  });

  it('even when the deadline cuts every run, every org is warmed within ceil(N / warmed per run) + 1 runs', () => {
    // A window is 48, but only the first 30 of it are warmed before the
    // deadline; the rest keep their old time and go first next run. With the
    // window chosen from the clock alone, the same tail was cut every time,
    // and for N = 96 or 144 a third of the orgs were never warmed.
    const PER_RUN = 30;
    for (const n of [96, 97, 144, 500]) {
      const active = orgs(n);
      const lastWarmed = new Map<string, number>();
      const warmedAt = new Map<string, number>();
      const bound = Math.ceil(n / PER_RUN) + 1;
      for (let run = 0; run < bound; run += 1) {
        const plan = planOrgSweep({
          knownHotOrgIds: KNOWN_HOT_ORG_IDS,
          activeOrgIds: active,
          windowSize: ORG_SWEEP_WINDOW,
          lastWarmed,
          now: 0,
        });
        expect(plan.orgIds.slice(0, 2)).toEqual([...KNOWN_HOT_ORG_IDS]);
        expect(plan.orgIds).toHaveLength(ORG_SWEEP_CAP);
        // The cron records the attempt of each window org it starts.
        for (const id of plan.windowOrgIds.slice(0, PER_RUN)) {
          lastWarmed.set(id, run);
          if (!warmedAt.has(id)) warmedAt.set(id, run);
        }
      }
      expect(warmedAt.size, `N=${n}`).toBe(n);
      // And keep going: no org waits longer than the bound between warms.
      for (let run = bound; run < bound * 4; run += 1) {
        const plan = planOrgSweep({
          knownHotOrgIds: KNOWN_HOT_ORG_IDS,
          activeOrgIds: active,
          windowSize: ORG_SWEEP_WINDOW,
          lastWarmed,
          now: 0,
        });
        for (const id of plan.windowOrgIds.slice(0, PER_RUN)) {
          expect(run - (lastWarmed.get(id) ?? -1), `N=${n} ${id}`).toBeLessThanOrEqual(bound);
          lastWarmed.set(id, run);
        }
      }
      for (const id of active) {
        expect(
          bound * 4 - 1 - (lastWarmed.get(id) ?? -Infinity),
          `N=${n} ${id}`,
        ).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('when the attempt records cannot be read, the window moves with the clock, never the same first 48 by id', () => {
    const active = orgs(500);
    const plan = (slot: number) =>
      planOrgSweep({
        knownHotOrgIds: KNOWN_HOT_ORG_IDS,
        activeOrgIds: active,
        windowSize: ORG_SWEEP_WINDOW,
        lastWarmed: null,
        now: slot * ORG_SWEEP_SLOT_MS,
      });
    const first = plan(980_000);
    expect(first.orgIds.slice(0, 2)).toEqual([...KNOWN_HOT_ORG_IDS]);
    expect(first.windowOrgIds).toHaveLength(ORG_SWEEP_WINDOW);
    expect(plan(980_001).windowOrgIds[0]).not.toBe(first.windowOrgIds[0]);
    // 30 of each window warmed (the deadline cuts the rest): every org is
    // still warmed within the clock order's bound.
    const warmed = new Set<string>();
    const bound = Math.ceil((2.7 * active.length) / 30) + 1;
    for (let run = 0; run < bound; run += 1) {
      for (const id of plan(980_000 + run).windowOrgIds.slice(0, 30)) warmed.add(id);
    }
    expect(warmed.size).toBe(active.length);
  });

  it('handles an empty enumeration (no active orgs) — known-hot still warm', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1', 'hot-2'],
      activeOrgIds: [],
      windowSize: 48,
      lastWarmed: none,
      now: 0,
    });
    expect(plan.orgIds).toEqual(['hot-1', 'hot-2']);
    expect(plan).toMatchObject({ rotating: 0, outsideWindow: 0, runsToCoverAll: 1 });
  });

  it('skips empty-string ids defensively', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1'],
      activeOrgIds: ['', 'org-a'],
      windowSize: 48,
      lastWarmed: none,
      now: 0,
    });
    expect(plan.orgIds).toEqual(['hot-1', 'org-a']);
  });

  it('exports a sane disclosed cap, its window and the two known-hot org ids', () => {
    // The cap is load-bearing for the route's 60s budget (see the
    // budget math comment) — a silent bump past ~50 needs the deadline
    // story re-checked, so pin it.
    expect(ORG_SWEEP_CAP).toBe(50);
    expect(KNOWN_HOT_ORG_IDS).toHaveLength(2);
    expect(ORG_SWEEP_WINDOW).toBe(48);
  });
});
