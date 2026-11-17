import { describe, expect, it } from 'vitest';

import {
  KNOWN_HOT_ORG_IDS,
  ORG_SWEEP_CAP,
  ORG_SWEEP_SLOT_MS,
  ORG_SWEEP_WINDOW,
  planOrgSweep,
} from './org-sweep';

const SLOT = ORG_SWEEP_SLOT_MS;
const orgs = (n: number) =>
  Array.from({ length: n }, (_, i) => `org-${String(i).padStart(4, '0')}`);

describe('planOrgSweep', () => {
  it('seeds known-hot orgs FIRST, then the enumerated orgs, deduped', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1', 'hot-2'],
      // hot-2 also shows up mid-list from the enumeration — must not repeat.
      activeOrgIds: ['org-a', 'hot-2', 'org-b'],
      windowSize: 48,
      now: 0,
    });
    expect(plan.orgIds).toEqual(['hot-1', 'hot-2', 'org-a', 'org-b']);
    expect(plan).toMatchObject({ rotating: 2, outsideWindow: 0, runsToCoverAll: 1 });
  });

  it('with no more orgs than the window, every run takes all of them, in order (as before)', () => {
    const active = orgs(48);
    for (const slot of [0, 1, 2, 977_000]) {
      const plan = planOrgSweep({
        knownHotOrgIds: ['hot-1'],
        activeOrgIds: active,
        windowSize: 48,
        now: slot * SLOT + 5_000,
      });
      expect(plan.orgIds).toEqual(['hot-1', ...active]);
      expect(plan.outsideWindow).toBe(0);
    }
  });

  it('past the window, consecutive runs take the next window and wrap around', () => {
    const active = orgs(100);
    const at = (slot: number) =>
      planOrgSweep({
        knownHotOrgIds: ['hot-1'],
        activeOrgIds: active,
        windowSize: 48,
        now: slot * SLOT,
      });
    expect(at(0).orgIds).toEqual(['hot-1', ...active.slice(0, 48)]);
    expect(at(1).orgIds).toEqual(['hot-1', ...active.slice(48, 96)]);
    expect(at(2).orgIds).toEqual(['hot-1', ...active.slice(96), ...active.slice(0, 44)]);
    expect(at(0)).toMatchObject({ rotating: 100, outsideWindow: 52, runsToCoverAll: 3 });
    // Any time inside one 30-minute slot gives the same window (the deploy
    // hook and the cron in the same half hour agree).
    expect(
      planOrgSweep({
        knownHotOrgIds: ['hot-1'],
        activeOrgIds: active,
        windowSize: 48,
        now: SLOT + SLOT - 1,
      }).orgIds,
    ).toEqual(at(1).orgIds);
  });

  it('every org is warmed within ceil(N / 48) consecutive runs, from any starting run', () => {
    // Before, the plan was the first 50 by recent activity every run: org 49
    // onward was never warmed.
    for (const n of [49, 96, 97, 150, 1000]) {
      const active = orgs(n);
      const runs = Math.ceil(n / ORG_SWEEP_WINDOW);
      for (const firstSlot of [0, 3, 984_321]) {
        const warmed = new Set<string>();
        for (let s = firstSlot; s < firstSlot + runs; s += 1) {
          const plan = planOrgSweep({
            knownHotOrgIds: KNOWN_HOT_ORG_IDS,
            activeOrgIds: active,
            windowSize: ORG_SWEEP_WINDOW,
            now: s * SLOT,
          });
          expect(plan.orgIds.slice(0, 2)).toEqual([...KNOWN_HOT_ORG_IDS]);
          expect(plan.orgIds).toHaveLength(ORG_SWEEP_CAP);
          for (const id of plan.orgIds.slice(2)) warmed.add(id);
        }
        expect(warmed.size, `N=${n} from slot ${firstSlot}`).toBe(n);
      }
    }
  });

  it('handles an empty enumeration (no active orgs) — known-hot still warm', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1', 'hot-2'],
      activeOrgIds: [],
      windowSize: 48,
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
      now: 0,
    });
    expect(plan.orgIds).toEqual(['hot-1', 'org-a']);
  });

  it('exports a sane disclosed cap, its rotating window and the two known-hot org ids', () => {
    // The cap is load-bearing for the route's 60s budget (see the
    // budget math comment) — a silent bump past ~50 needs the deadline
    // story re-checked, so pin it.
    expect(ORG_SWEEP_CAP).toBe(50);
    expect(KNOWN_HOT_ORG_IDS).toHaveLength(2);
    expect(ORG_SWEEP_WINDOW).toBe(48);
    expect(ORG_SWEEP_SLOT_MS).toBe(30 * 60_000);
  });
});
