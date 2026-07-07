import { describe, expect, it } from 'vitest';

import { KNOWN_HOT_ORG_IDS, ORG_SWEEP_CAP, planOrgSweep } from './org-sweep';

describe('planOrgSweep', () => {
  it('seeds known-hot orgs FIRST, then activity-ordered orgs, deduped', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1', 'hot-2'],
      // hot-2 also shows up mid-list from the enumeration — must not repeat.
      activeOrgIds: ['org-a', 'hot-2', 'org-b'],
      cap: 50,
    });
    expect(plan).toEqual(['hot-1', 'hot-2', 'org-a', 'org-b']);
  });

  it('caps the list AFTER seeding, so known-hot ids never fall off the edge', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1'],
      activeOrgIds: ['org-a', 'org-b', 'org-c'],
      cap: 2,
    });
    expect(plan).toEqual(['hot-1', 'org-a']);
  });

  it('handles an empty enumeration (no active orgs) — known-hot still warm', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1', 'hot-2'],
      activeOrgIds: [],
      cap: 50,
    });
    expect(plan).toEqual(['hot-1', 'hot-2']);
  });

  it('skips empty-string ids defensively', () => {
    const plan = planOrgSweep({
      knownHotOrgIds: ['hot-1'],
      activeOrgIds: ['', 'org-a'],
      cap: 50,
    });
    expect(plan).toEqual(['hot-1', 'org-a']);
  });

  it('exports a sane disclosed cap and the two known-hot org ids', () => {
    // The cap is load-bearing for the route's 60s budget (see the
    // budget math comment) — a silent bump past ~50 needs the deadline
    // story re-checked, so pin it.
    expect(ORG_SWEEP_CAP).toBe(50);
    expect(KNOWN_HOT_ORG_IDS).toHaveLength(2);
  });
});
