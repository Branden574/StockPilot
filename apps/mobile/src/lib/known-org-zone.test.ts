import { describe, expect, it } from 'vitest';

import { knownZoneFor, nextKnownOrgZone, type KnownOrgZone } from './known-org-zone';
import * as receiveOverdue from './receive-overdue';

/**
 * The organization zone a phone screen keeps between reads (L7, after #338).
 *
 * readOrgTimeZone answers null for a failed read as for an unset zone, so a
 * screen that re-reads the zone on a refresh (Movements, the home screen) must
 * not let a failed read put a Sydney organization on the default zone, and a
 * screen must never print one workspace's movements in another's zone.
 */

const SYDNEY = 'Australia/Sydney';
const LA = 'America/Los_Angeles';

describe('nextKnownOrgZone', () => {
  it('takes what a read answered', () => {
    expect(nextKnownOrgZone(null, 'org-a', SYDNEY)).toEqual({ orgId: 'org-a', zone: SYDNEY });
    expect(nextKnownOrgZone({ orgId: 'org-a', zone: SYDNEY }, 'org-a', LA)).toEqual({
      orgId: 'org-a',
      zone: LA,
    });
  });

  it("keeps the zone already read for the same organization when a refresh's read fails", () => {
    const prev: KnownOrgZone = { orgId: 'org-a', zone: SYDNEY };
    expect(nextKnownOrgZone(prev, 'org-a', null)).toBe(prev);
  });

  it("starts another organization from its own read, never the previous organization's zone", () => {
    expect(nextKnownOrgZone({ orgId: 'org-a', zone: SYDNEY }, 'org-b', null)).toEqual({
      orgId: 'org-b',
      zone: null,
    });
  });

  it('is the very function the Receive POs screen keeps its zone with', () => {
    expect(receiveOverdue.nextKnownOrgZone).toBe(nextKnownOrgZone);
  });
});

describe('knownZoneFor', () => {
  it("answers the zone held for this organization", () => {
    expect(knownZoneFor({ orgId: 'org-a', zone: SYDNEY }, 'org-a')).toBe(SYDNEY);
  });

  it("answers null (core's default zone) before any read, for another organization's zone, or with no organization", () => {
    expect(knownZoneFor(null, 'org-a')).toBeNull();
    expect(knownZoneFor({ orgId: 'org-a', zone: SYDNEY }, 'org-b')).toBeNull();
    expect(knownZoneFor({ orgId: 'org-a', zone: SYDNEY }, null)).toBeNull();
  });
});
