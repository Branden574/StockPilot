import { describe, expect, it } from 'vitest';

import { knownZoneFor, nextKnownOrgZone, type KnownOrgZone } from './known-org-zone';
import { createNewestRead } from './newest-read';

/**
 * Slice 3 review (2026-10-24). The phone item screen read the organization's
 * zone once per screen and never again, so one failed first read (offline)
 * kept its MOVEMENTS and ACTIVITY cards in core's default zone for the
 * screen's whole life, even after a pull-to-refresh; Staging read it only when
 * it opened. Nor did the item screen drop a late answer, so a workspace switch
 * while its read was out could put the previous workspace's zone in place of
 * the current one's. Both screens now read through createNewestRead, and read
 * again on a refresh.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SYDNEY = 'Australia/Sydney';
const TOKYO = 'Asia/Tokyo';

/** A screen's zone, kept as the item screen keeps it, read by hand. */
function zoneScreen(start: KnownOrgZone | null = null) {
  let known = start;
  const out: { orgId: string; answer: Deferred<string | null> }[] = [];
  const reads = createNewestRead(
    (orgId: string) => {
      const answer = deferred<string | null>();
      out.push({ orgId, answer });
      return answer.promise;
    },
    (orgId, zone) => {
      known = nextKnownOrgZone(known, orgId, zone);
    },
    null,
  );
  return { reads, out, zoneFor: (orgId: string) => knownZoneFor(known, orgId), known: () => known };
}

describe('createNewestRead: the organization zone a screen reads on its own', () => {
  it('lands what the read answered, for its organization', async () => {
    const s = zoneScreen();
    const read = s.reads.read('org-a');
    s.out[0]!.answer.resolve(SYDNEY);
    await read;
    expect(s.zoneFor('org-a')).toBe(SYDNEY);
  });

  it("a late answer for the previous workspace never replaces the current one's zone", async () => {
    const s = zoneScreen();
    const first = s.reads.read('org-a');
    const afterSwitch = s.reads.read('org-b');
    s.out[1]!.answer.resolve(TOKYO);
    await afterSwitch;
    s.out[0]!.answer.resolve(SYDNEY);
    await first;
    expect(s.known()).toEqual({ orgId: 'org-b', zone: TOKYO });
    expect(s.zoneFor('org-b')).toBe(TOKYO);
  });

  it('a failed first read leaves the default zone, and reading again (a pull-to-refresh) puts the zone in place', async () => {
    const s = zoneScreen();
    const offline = s.reads.read('org-a');
    s.out[0]!.answer.resolve(null);
    await offline;
    expect(s.zoneFor('org-a')).toBeNull();
    // Nothing is out any more, so the screen may read again.
    expect(s.reads.pendingFor()).toBeNull();
    const refresh = s.reads.read('org-a');
    s.out[1]!.answer.resolve(SYDNEY);
    await refresh;
    expect(s.zoneFor('org-a')).toBe(SYDNEY);
  });

  it('a failed refresh keeps the zone already read', async () => {
    const s = zoneScreen({ orgId: 'org-a', zone: SYDNEY });
    const refresh = s.reads.read('org-a');
    s.out[0]!.answer.resolve(null);
    await refresh;
    expect(s.zoneFor('org-a')).toBe(SYDNEY);
  });

  it("for the same organization too, the newest read's answer stands over an older read that answers later", async () => {
    const s = zoneScreen();
    const slow = s.reads.read('org-a');
    const refresh = s.reads.read('org-a');
    s.out[1]!.answer.resolve(TOKYO);
    await refresh;
    s.out[0]!.answer.resolve(SYDNEY);
    await slow;
    expect(s.zoneFor('org-a')).toBe(TOKYO);
  });
});

describe('createNewestRead: what is out, cancelling, and failures', () => {
  it('pendingFor names the key whose newest read is out; an answer that came too late clears nothing', async () => {
    const s = zoneScreen();
    expect(s.reads.pendingFor()).toBeNull();
    const first = s.reads.read('org-a');
    expect(s.reads.pendingFor()).toBe('org-a');
    const second = s.reads.read('org-b');
    expect(s.reads.pendingFor()).toBe('org-b');
    s.out[0]!.answer.resolve(SYDNEY);
    await first;
    expect(s.reads.pendingFor()).toBe('org-b');
    s.out[1]!.answer.resolve(TOKYO);
    await second;
    expect(s.reads.pendingFor()).toBeNull();
  });

  it('cancel drops the answer still out (the workspace went away)', async () => {
    const s = zoneScreen();
    const read = s.reads.read('org-a');
    s.reads.cancel();
    expect(s.reads.pendingFor()).toBeNull();
    s.out[0]!.answer.resolve(SYDNEY);
    await read;
    expect(s.known()).toBeNull();
  });

  it('a read that throws answers the failed value, and read never rejects, so a refresh that waits for it ends', async () => {
    const landed: [string, string | null][] = [];
    const reads = createNewestRead(
      async (orgId: string): Promise<string | null> => {
        throw new Error(`offline: ${orgId}`);
      },
      (orgId, zone) => {
        landed.push([orgId, zone]);
      },
      null,
    );
    await expect(reads.read('org-a')).resolves.toBeUndefined();
    expect(landed).toEqual([['org-a', null]]);
    expect(reads.pendingFor()).toBeNull();
  });
});
