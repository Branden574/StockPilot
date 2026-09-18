import { describe, expect, it } from 'vitest';

import { compareBuilds, parseServedVersion, refreshRequired } from './detector';

/**
 * The old VersionNotifier had no tests and three wrong answers: a tab opened
 * mid-deploy never learned it was stale, a rollback was announced as "a new
 * version", and A -> B -> A left a stale prompt up forever. Each is a case here.
 */

const A = { build: 'aaaaaaaaaaaa', builtAt: '2026-09-18T10:00:00.000Z' };
const B = { build: 'bbbbbbbbbbbb', builtAt: '2026-09-18T12:00:00.000Z' };
const C = { build: 'cccccccccccc', builtAt: '2026-09-18T12:05:00.000Z' };

describe('compareBuilds', () => {
  it('is current when production serves this tab’s build', () => {
    expect(compareBuilds(A, A)).toBe('current');
  });

  it('sees a forward deploy', () => {
    expect(compareBuilds(A, B)).toBe('update_available');
  });

  it('calls a rollback a rollback: the served build is OLDER than the loaded one', () => {
    expect(compareBuilds(B, A)).toBe('rolled_back');
  });

  it('A -> B -> A clears itself, because the answer depends only on (loaded, served)', () => {
    expect(compareBuilds(A, B)).toBe('update_available');
    expect(compareBuilds(A, A)).toBe('current');
  });

  it('rapid A -> B -> C is one state, not two', () => {
    expect(compareBuilds(A, B)).toBe('update_available');
    expect(compareBuilds(A, C)).toBe('update_available');
  });

  it('never orders builds by their ids', () => {
    // 'zzzz' sorts after 'aaaa' but was built EARLIER: still a rollback.
    const z = { build: 'zzzzzzzzzzzz', builtAt: '2026-09-01T00:00:00.000Z' };
    expect(compareBuilds(A, z)).toBe('rolled_back');
  });

  it('assumes forward motion when either build time is missing (a deployment older than builtAt)', () => {
    expect(compareBuilds(A, { build: 'bbbbbbbbbbbb', builtAt: null })).toBe('update_available');
    expect(compareBuilds({ build: 'aaaaaaaaaaaa', builtAt: null }, B)).toBe('update_available');
    expect(compareBuilds(A, { build: 'bbbbbbbbbbbb', builtAt: 'not-a-date' })).toBe(
      'update_available',
    );
  });

  it('stays silent when it cannot tell: development has no loaded build, and a failed poll serves nothing', () => {
    expect(compareBuilds({ build: '', builtAt: null }, B)).toBe('unknown');
    expect(compareBuilds(A, null)).toBe('unknown');
    expect(compareBuilds(A, { build: '', builtAt: null })).toBe('unknown');
  });
});

describe('refreshRequired', () => {
  it('is true for a forward deploy AND a rollback, false otherwise', () => {
    expect(refreshRequired('update_available')).toBe(true);
    expect(refreshRequired('rolled_back')).toBe(true);
    expect(refreshRequired('current')).toBe(false);
    expect(refreshRequired('unknown')).toBe(false);
  });
});

describe('parseServedVersion', () => {
  it('reads the full shape', () => {
    expect(
      parseServedVersion({
        build: 'bbbbbbbbbbbb',
        builtAt: B.builtAt,
        env: 'production',
        releasesKey: '0123456789ab',
      }),
    ).toEqual({
      build: 'bbbbbbbbbbbb',
      builtAt: B.builtAt,
      releasesKey: '0123456789ab',
    });
  });

  it('reads the ORIGINAL shape an older deployment still answers with', () => {
    expect(parseServedVersion({ build: 'aaaaaaaaaaaa' })).toEqual({
      build: 'aaaaaaaaaaaa',
      builtAt: null,
      releasesKey: null,
    });
  });

  it('returns null for anything unusable, and never throws', () => {
    for (const junk of [
      null,
      undefined,
      'a string',
      42,
      [],
      {},
      { build: '' },
      { build: 12 },
      { releasesKey: 'abc' },
    ]) {
      expect(parseServedVersion(junk)).toBeNull();
    }
    expect(parseServedVersion({ build: 'x', releasesKey: 7, builtAt: 5 })).toEqual({
      build: 'x',
      builtAt: null,
      releasesKey: null,
    });
  });
});
