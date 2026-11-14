import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { screenCallback } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';
import { joinMemberProfiles } from './org-members';

/**
 * USERS, TEAM AND CUSTOMERS DRAW ONLY ROWS READ FOR THE WORKSPACE ON SCREEN
 * (B124).
 *
 * The three kept one list of rows across a workspace switch: the previous
 * workspace's members or customer accounts stood under the new workspace
 * until its read answered, for good when that read failed, and an older
 * read that landed last replaced the newer one. Now each keeps its rows
 * with the workspace they were read for and draws them only for the
 * workspace on screen (the admin lists' pattern, admin-lists-workspace.test.ts),
 * and numbers its reads so only the newest changes the list. Users also
 * closes a member's role sheet opened in another workspace.
 *
 * Each screen's own `load` is RUN here (screen-functions.ts) for workspace A
 * and then B, with A's read answering last.
 */

const ORG_A = '0a000000-0000-0000-0000-00000000000a';
const ORG_B = '0b000000-0000-0000-0000-00000000000b';
const USERS = 'app/(drawer)/admin/users.tsx';
const TEAM = 'app/(drawer)/team.tsx';
const CUSTOMERS = 'app/(drawer)/customers.tsx';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Stored = { orgId: string; rows: { user_id?: string; id?: string }[] } | null;

function store() {
  const state = { list: null as Stored, failed: undefined as unknown };
  const setList = (v: unknown) => {
    state.list = typeof v === 'function' ? (v as (p: Stored) => Stored)(state.list) : (v as Stored);
  };
  return { state, setList };
}

/** loadOrgMembers stood in for: one member per workspace, answered when `gate` opens. */
function members(fail: (org: string) => boolean, gates: Map<string, Promise<void>>) {
  return async (_client: unknown, orgId: string) => {
    await (gates.get(orgId) ?? Promise.resolve());
    if (fail(orgId)) throw new Error('Network request failed');
    return {
      members: [
        { user_id: `member-of-${orgId}`, role: 'staff', accepted_at: null, created_at: '' },
      ],
      profiles: new Map(),
    };
  };
}

function memberScreen(file: string, opts: { fail?: (org: string) => boolean } = {}) {
  const { state, setList } = store();
  const guard = { current: createSequenceGuard() };
  const gates = new Map<string, Promise<void>>();
  const build = (orgId: string) =>
    screenCallback<() => Promise<void>>(file, 'load', {
      orgId,
      // One account throughout; another account is gated-lists-keyed.test.ts.
      userId: 'u1',
      isAdmin: true,
      supabase: {},
      loadOrgMembers: members(opts.fail ?? (() => false), gates),
      joinMemberProfiles,
      setList,
      setLoadFailed: (v: unknown) => {
        state.failed = v;
      },
      setLoading: () => undefined,
      guard,
      console: { warn: vi.fn() },
    });
  return { state, build, gates };
}

describe.each([
  ['Users', USERS],
  ['Team', TEAM],
])('%s', (_label, file) => {
  it('an older read that lands last never replaces the newer workspace’s rows', async () => {
    const { state, build, gates } = memberScreen(file);
    const slowA = deferred();
    gates.set(ORG_A, slowA.promise);
    const loadA = build(ORG_A)();
    await build(ORG_B)();
    expect(state.list?.orgId).toBe(ORG_B);
    slowA.resolve();
    await loadA;
    expect(state.list?.orgId).toBe(ORG_B);
    expect(state.list?.rows.map((r) => r.user_id)).toEqual([`member-of-${ORG_B}`]);
  });

  it("a failed read never leaves another workspace's rows", async () => {
    const { state, build } = memberScreen(file, { fail: (org) => org === ORG_B });
    await build(ORG_A)();
    expect(state.list?.orgId).toBe(ORG_A);
    await build(ORG_B)();
    expect(state.failed).toBe(true);
    expect(state.list === null || state.list.orgId === ORG_B).toBe(true);
  });

  it('draws only rows read for the workspace on screen', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', file), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain(
      'const rows = list !== null && list.orgId === orgId && list.userId === userId ? list.rows : NO_ROWS;',
    );
    expect(src).toContain('const guard = React.useRef(createSequenceGuard());');
  });
});

describe('Users: a role sheet opened in another workspace closes', () => {
  it('keeps the member being edited with its workspace (and its account: gated-lists-keyed.test.ts)', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', USERS), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain(
      'return editingFor !== null && editingFor.orgId === orgId && editingFor.userId === userId ? editingFor.row : null;',
    );
    expect(src).toContain('const editing = roleSheetRow();');
  });
});

describe('Customers', () => {
  function customerScreen(answers: Map<string, { gate: Promise<void>; error: unknown }>) {
    const { state, setList } = store();
    const guard = { current: createSequenceGuard() };
    const build = (orgId: string) => {
      const q: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'order']) q[k] = () => q;
      q.limit = async () => {
        const a = answers.get(orgId);
        await (a?.gate ?? Promise.resolve());
        return a?.error
          ? { data: null, error: a.error }
          : { data: [{ id: `account-of-${orgId}` }], error: null };
      };
      return screenCallback<() => Promise<void>>(CUSTOMERS, 'load', {
        user: { id: 'u1' },
        userId: 'u1',
        activeOrgId: orgId,
        supabase: { from: () => q },
        setList,
        setLoadFailed: (v: unknown) => {
          state.failed = v;
        },
        setLoading: () => undefined,
        guard,
      });
    };
    return { state, build };
  }

  it('an older read that lands last never replaces the newer workspace’s accounts', async () => {
    const slowA = deferred();
    const { state, build } = customerScreen(
      new Map([[ORG_A, { gate: slowA.promise, error: null }]]),
    );
    const loadA = build(ORG_A)();
    await build(ORG_B)();
    slowA.resolve();
    await loadA;
    expect(state.list?.orgId).toBe(ORG_B);
    expect(state.list?.rows.map((r) => r.id)).toEqual([`account-of-${ORG_B}`]);
  });

  it("a failed read keeps this workspace's earlier accounts, never another's", async () => {
    const { state, build } = customerScreen(
      new Map([[ORG_B, { gate: Promise.resolve(), error: { message: 'offline' } }]]),
    );
    await build(ORG_A)();
    await build(ORG_B)();
    expect(state.failed).toBe(true);
    // A's accounts may stay stored, but are drawn only for A (pinned below).
    expect(state.list?.orgId).toBe(ORG_A);
  });

  it('draws only accounts read for the workspace on screen', () => {
    const src = readFileSync(path.resolve(__dirname, '../..', CUSTOMERS), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(src).toContain(
      'const rows = list !== null && list.orgId === activeOrgId && list.userId === userId ? list.rows : NO_ROWS;',
    );
    expect(src).toContain('const guard = React.useRef(createSequenceGuard());');
  });
});
