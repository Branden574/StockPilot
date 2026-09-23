import { describe, expect, it } from 'vitest';

import {
  fakePostgrest,
  filterValue,
  inValues,
  uuid,
  type RecordedCall,
} from './__fixtures__/fake-postgrest';
import { IdBatchReadError, IN_FILTER_MAX_VALUES, type PageResult } from './id-batches';
import {
  buildReassignCandidates,
  joinMemberProfiles,
  loadOrgMembers,
  type OrgMemberRow,
} from './org-members';

const ORG = 'org-1';

interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
}

function orgServer(opts: {
  members: OrgMemberRow[];
  fail?: 'organization_members' | 'user_profiles';
  /** Fail only the profile batch holding this id. */
  poison?: string;
}) {
  return fakePostgrest((call: RecordedCall): PageResult<unknown> => {
    if (call.table === opts.fail) return { data: null, error: { message: 'offline' }, status: 0 };
    if (call.table === 'organization_members') {
      const acceptedOnly = call.filters.some(([op, col]) => op === 'not' && col === 'accepted_at');
      const rows = opts.members.filter((m) => !acceptedOnly || m.accepted_at !== null);
      return { data: rows.slice(call.from, call.to + 1), error: null, status: 200 };
    }
    const ids = (inValues(call, 'id') ?? []) as string[];
    if (opts.poison && ids.includes(opts.poison)) {
      return { data: null, error: { message: 'URI too long' }, status: 414 };
    }
    const rows = ids.map((id) => ({ id, full_name: `Name ${id.slice(-4)}`, email: null }));
    return { data: rows.slice(call.from, call.to + 1), error: null, status: 200 };
  });
}

const member = (i: number, accepted = true): OrgMemberRow => ({
  user_id: uuid(i),
  role: i === 0 ? 'owner' : 'staff',
  accepted_at: accepted ? '2026-09-01T00:00:00Z' : null,
  created_at: '2026-08-01T00:00:00Z',
});

describe('loadOrgMembers', () => {
  it('reads members org-scoped and pending first, then profiles in batches of at most 100', async () => {
    const members = Array.from({ length: 250 }, (_, i) => member(i));
    const client = orgServer({ members });
    const out = await loadOrgMembers<Profile>(client, ORG, { profileColumns: 'id, full_name, email' });
    expect(out.members).toHaveLength(250);
    expect(out.profiles.size).toBe(250);
    const memberCalls = client.calls.filter((c) => c.table === 'organization_members');
    expect(memberCalls).toHaveLength(1);
    expect(filterValue(memberCalls[0]!, 'eq', 'organization_id')).toBe(ORG);
    expect(memberCalls[0]!.order).toEqual([
      ['accepted_at', false],
      ['id', true],
    ]);
    const profileCalls = client.calls.filter((c) => c.table === 'user_profiles');
    expect(profileCalls).toHaveLength(3);
    for (const c of profileCalls) {
      expect(c.select).toBe('id, full_name, email');
      expect(inValues(c, 'id')!.length).toBeLessThanOrEqual(IN_FILTER_MAX_VALUES);
    }
  });

  it('pages the members read past the 1000-row cap', async () => {
    const members = Array.from({ length: 1200 }, (_, i) => member(i));
    const client = orgServer({ members });
    const out = await loadOrgMembers<Profile>(client, ORG, { profileColumns: 'id, full_name, email' });
    expect(out.members).toHaveLength(1200);
    const memberCalls = client.calls.filter((c) => c.table === 'organization_members');
    expect(memberCalls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('acceptedOnly adds the accepted filter', async () => {
    const client = orgServer({ members: [member(1), member(2, false)] });
    const out = await loadOrgMembers<Profile>(client, ORG, {
      profileColumns: 'id, full_name, email',
      acceptedOnly: true,
    });
    expect(out.members.map((m) => m.user_id)).toEqual([uuid(1)]);
    expect(client.calls[0]!.filters).toContainEqual(['not', 'accepted_at', ['is', null]]);
  });

  it('a failed members read REJECTS (it used to read as "No users yet.")', async () => {
    const client = orgServer({ members: [member(1)], fail: 'organization_members' });
    await expect(
      loadOrgMembers<Profile>(client, ORG, { profileColumns: 'id, full_name, email' }),
    ).rejects.toBeInstanceOf(IdBatchReadError);
  });

  it('a failed profile batch REJECTS: the exact reassign-sheet bug, where the error was returned, not thrown', async () => {
    const members = Array.from({ length: 250 }, (_, i) => member(i));
    const client = orgServer({ members, poison: uuid(180) });
    await expect(
      loadOrgMembers<Profile>(client, ORG, { profileColumns: 'id, full_name, email' }),
    ).rejects.toThrow('URI too long');
  });

  it('makes no profile request for an org with no members', async () => {
    const client = orgServer({ members: [] });
    const out = await loadOrgMembers<Profile>(client, ORG, { profileColumns: 'id, full_name, email' });
    expect(out.members).toEqual([]);
    expect(client.calls.filter((c) => c.table === 'user_profiles')).toHaveLength(0);
  });
});

describe('joinMemberProfiles', () => {
  it('joins in member order, with null for a member with no profile', () => {
    const members = [member(3), member(1), member(2)];
    const profiles = new Map<string, Profile>([
      [uuid(1), { id: uuid(1), full_name: 'One', email: null }],
      [uuid(3), { id: uuid(3), full_name: 'Three', email: null }],
    ]);
    expect(joinMemberProfiles(members, profiles).map((j) => [j.member.user_id, j.profile?.full_name ?? null])).toEqual([
      [uuid(3), 'Three'],
      [uuid(1), 'One'],
      [uuid(2), null],
    ]);
  });
});

describe('buildReassignCandidates', () => {
  it('keeps members with a profile, names them by full name then email, sorted by name', () => {
    const members = [member(1), member(2), member(3)];
    const profiles = new Map<string, Profile>([
      [uuid(1), { id: uuid(1), full_name: 'Zoe', email: 'z@x' }],
      [uuid(2), { id: uuid(2), full_name: null, email: 'amy@x' }],
    ]);
    expect(buildReassignCandidates(members, profiles)).toEqual([
      { userId: uuid(2), name: 'amy@x', role: 'staff' },
      { userId: uuid(1), name: 'Zoe', role: 'staff' },
    ]);
  });
});
