import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  canSettleOutbox,
  HELD_FOR_OTHER_SQL,
  heldForSetUp,
  isOwnedBy,
  outboxSendDecision,
  OWNED_BY_USER_SQL,
  type OutboxRowOwner,
  type OutboxSendDecision,
} from './outbox-scope';
import {
  beginSetUpRead,
  noteServerReadUser,
  recordMembershipInputs,
  resetSetUpInputsForTests,
} from './set-up-inputs';

/**
 * The one scope rule for queued work (S4a, owner decision D4). Pure cases,
 * then proof that the SQL fragments the counters use say exactly what the
 * function the drains use says, then wiring pins that both drains and every
 * counter go through them (recurring pattern #26).
 */

describe('outboxSendDecision', () => {
  const live = { orgId: 'org-b', userId: 'u1', stepUpOwed: false };

  it('own row: sent under ITS organization, not the active one', () => {
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, live)).toEqual({
      send: true,
      orgId: 'org-a',
      userId: 'u1',
      adopt: false,
    });
  });

  it("another account's row is held", () => {
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u2' }, live)).toEqual({
      send: false,
      reason: 'other-account',
    });
  });

  it('nobody signed in: nothing is sent, not even a legacy row', () => {
    expect(
      outboxSendDecision({ organizationId: null, userId: null }, { orgId: 'org-b', userId: null, stepUpOwed: false }),
    ).toEqual({
      send: false,
      reason: 'signed-out',
    });
    expect(
      outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, { orgId: null, userId: null, stepUpOwed: false }),
    ).toEqual({
      send: false,
      reason: 'signed-out',
    });
  });

  it('legacy row (older binary, no owner): sent under the live context and adopted', () => {
    expect(outboxSendDecision({ organizationId: null, userId: null }, live)).toEqual({
      send: true,
      orgId: 'org-b',
      userId: 'u1',
      adopt: true,
    });
    // Fields absent altogether (a row object from an older bundle's shape).
    expect(outboxSendDecision({}, live)).toMatchObject({ send: true, adopt: true });
  });

  it('own row queued before a workspace was saved: live org, adopted', () => {
    expect(outboxSendDecision({ organizationId: null, userId: 'u1' }, live)).toEqual({
      send: true,
      orgId: 'org-b',
      userId: 'u1',
      adopt: true,
    });
  });
});

/**
 * docket S43b. While the live session still owes its authenticator code,
 * nothing is sent under it: every row is held, left as it is, and goes out
 * once the code is entered.
 */
describe('a session that still owes its authenticator code sends nothing', () => {
  const owing = { orgId: 'org-b', userId: 'u1', stepUpOwed: true };
  const HELD = { send: false, reason: 'step-up-owed' };

  it("the account's own row is held, with its own workspace or without", () => {
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, owing)).toEqual(HELD);
    expect(outboxSendDecision({ organizationId: null, userId: 'u1' }, owing)).toEqual(HELD);
  });

  it('a legacy row is held too: it is not adopted by a session that has not entered its code', () => {
    expect(outboxSendDecision({ organizationId: null, userId: null }, owing)).toEqual(HELD);
    expect(outboxSendDecision({}, owing)).toEqual(HELD);
  });

  it("another account's row is held for the same reason: nothing about the queue is decided yet", () => {
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u2' }, owing)).toEqual(HELD);
  });

  it('while the workspace is not saved either, the code is still what holds the row', () => {
    expect(
      outboxSendDecision(
        { organizationId: null, userId: 'u1' },
        { orgId: null, userId: 'u1', stepUpOwed: true },
      ),
    ).toEqual(HELD);
  });

  it('nobody signed in is still "signed out", whatever the scope says about a code', () => {
    expect(
      outboxSendDecision(
        { organizationId: 'org-a', userId: 'u1' },
        { orgId: 'org-b', userId: null, stepUpOwed: true },
      ),
    ).toEqual({ send: false, reason: 'signed-out' });
  });

  it('once the code is entered the same rows go, exactly as before', () => {
    const entered = { ...owing, stepUpOwed: false };
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, entered)).toEqual({
      send: true,
      orgId: 'org-a',
      userId: 'u1',
      adopt: false,
    });
    expect(outboxSendDecision({ organizationId: null, userId: null }, entered)).toEqual({
      send: true,
      orgId: 'org-b',
      userId: 'u1',
      adopt: true,
    });
  });

  it('nothing queued is settled either: not signed out, and not before the code', () => {
    expect(canSettleOutbox({ orgId: 'org-b', userId: 'u1', stepUpOwed: false })).toBe(true);
    expect(canSettleOutbox({ orgId: null, userId: 'u1', stepUpOwed: false })).toBe(true);
    expect(canSettleOutbox(owing)).toBe(false);
    expect(canSettleOutbox({ orgId: 'org-b', userId: null, stepUpOwed: false })).toBe(false);
    expect(canSettleOutbox({ orgId: 'org-b', userId: null, stepUpOwed: true })).toBe(false);
  });

  it('no row is ever sent under a scope that owes its code', () => {
    const rows: OutboxRowOwner[] = [
      {},
      { organizationId: null, userId: null },
      { organizationId: '', userId: null },
      { organizationId: null, userId: 'u1' },
      { organizationId: 'org-a', userId: 'u1' },
      { organizationId: 'org-a', userId: null },
      { organizationId: 'org-a', userId: 'u2' },
    ];
    for (const row of rows) {
      for (const orgId of [null, '', 'org-b']) {
        for (const userId of [null, 'u1']) {
          const decision = outboxSendDecision(row, { orgId, userId, stepUpOwed: true });
          expect(decision.send, JSON.stringify({ row, orgId, userId })).toBe(false);
        }
      }
    }
  });
});

/**
 * docket B10, integrator decision 3. A row with no workspace of its own (an
 * older build's legacy row, or one queued before any workspace was saved) is
 * sent under the live account's OWN saved workspace (session-scope.ts
 * liveOutboxScope). While there is none (nothing saved, another account's, or
 * an older build's with no owner), live.orgId is null, and the row used to be
 * sent with that null: api() then sent no X-Organization-Id at all, and the
 * server applied the change in the account's default organization. It is
 * held instead, as pending, until that workspace is saved.
 */
describe("a row with no workspace of its own waits for its account's own", () => {
  /** Signed in, the account's own workspace not saved yet. */
  const loading = { orgId: null, userId: 'u1', stepUpOwed: false };
  const HELD = { send: false, reason: 'workspace-loading' };

  it('a legacy row (an older build: no account, no workspace) is held, never sent with no workspace', () => {
    expect(outboxSendDecision({ organizationId: null, userId: null }, loading)).toEqual(HELD);
    expect(outboxSendDecision({}, loading)).toEqual(HELD);
  });

  it("the account's own row queued before any workspace was saved is held too", () => {
    expect(outboxSendDecision({ organizationId: null, userId: 'u1' }, loading)).toEqual(HELD);
  });

  it('a row with its own workspace is sent under it, whatever the live one is', () => {
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, loading)).toEqual({
      send: true,
      orgId: 'org-a',
      userId: 'u1',
      adopt: false,
    });
  });

  it("another account's row and nobody signed in are decided first, as before", () => {
    expect(outboxSendDecision({ organizationId: null, userId: 'u2' }, loading)).toEqual({
      send: false,
      reason: 'other-account',
    });
    expect(
      outboxSendDecision({ organizationId: null, userId: null }, { orgId: null, userId: null, stepUpOwed: false }),
    ).toEqual({ send: false, reason: 'signed-out' });
  });

  it("once the account's own workspace is saved, the row goes under it and is stamped with it", () => {
    expect(
      outboxSendDecision(
        { organizationId: null, userId: null },
        { orgId: 'org-own', userId: 'u1', stepUpOwed: false },
      ),
    ).toEqual({ send: true, orgId: 'org-own', userId: 'u1', adopt: true });
  });

  it('an empty organization is no organization: api() would send no header for it', () => {
    // api.ts sends X-Organization-Id only for a non-empty orgId and otherwise
    // falls back to the saved one, so '' must never reach it as a workspace.
    expect(outboxSendDecision({ organizationId: '', userId: 'u1' }, loading)).toEqual(HELD);
    expect(
      outboxSendDecision({ organizationId: '', userId: 'u1' }, { orgId: 'org-b', userId: 'u1', stepUpOwed: false }),
    ).toEqual({ send: true, orgId: 'org-b', userId: 'u1', adopt: true });
    expect(
      outboxSendDecision({ organizationId: null, userId: 'u1' }, { orgId: '', userId: 'u1', stepUpOwed: false }),
    ).toEqual(HELD);
  });

  it('no row and no live scope gives a send without a workspace', () => {
    const rows: OutboxRowOwner[] = [
      {},
      { organizationId: null, userId: null },
      { organizationId: '', userId: null },
      { organizationId: null, userId: 'u1' },
      { organizationId: 'org-a', userId: 'u1' },
      { organizationId: 'org-a', userId: null },
    ];
    const lives = [
      { orgId: null, userId: 'u1', stepUpOwed: false },
      { orgId: '', userId: 'u1', stepUpOwed: false },
      { orgId: 'org-b', userId: 'u1', stepUpOwed: false },
      { orgId: null, userId: null, stepUpOwed: false },
    ];
    let sends = 0;
    for (const row of rows) {
      for (const scope of lives) {
        const decision = outboxSendDecision(row, scope);
        if (!decision.send) continue;
        sends += 1;
        expect(decision.orgId, JSON.stringify({ row, scope })).toMatch(/^\S+$/);
      }
    }
    expect(sends).toBeGreaterThan(0); // vacuity control
  });

  it('the type says it too: a decision to send always carries a workspace', () => {
    expectTypeOf<Extract<OutboxSendDecision, { send: true }>['orgId']>().toEqualTypeOf<string>();
  });
});

/**
 * Authenticator set-up is owed per WORKSPACE: its policy and this account's
 * role there (set-up-inputs.ts). A row is held while ITS OWN workspace answers
 * 'owed', whichever workspace is active, and left exactly as it is.
 */
describe('a row whose own workspace owes authenticator set-up is held', () => {
  const live = { orgId: 'org-optional', userId: 'u1', stepUpOwed: false };
  const HELD = { send: false, reason: 'set-up-owed' };

  beforeEach(() => {
    resetSetUpInputsForTests();
    recordMembershipInputs(
      'u1',
      [
        { organizationId: 'org-optional', role: 'staff', organization: { name: 'Opt', mfa_policy: 'optional' } },
        // The embed as an array of one, as some answers give it.
        { organizationId: 'org-all', role: 'staff', organization: [{ name: 'All', mfa_policy: 'all_required' }] },
        { organizationId: 'org-admins', role: 'staff', organization: { name: 'Adm', mfa_policy: 'admins_required' } },
        { organizationId: 'org-hidden', role: 'staff', organization: null },
      ],
      beginSetUpRead(),
    );
    noteServerReadUser({ id: 'u1', factors: [] });
  });
  afterEach(() => resetSetUpInputsForTests());

  it('a row queued in a requiring workspace while an Optional one is active: held', () => {
    expect(outboxSendDecision({ organizationId: 'org-all', userId: 'u1' }, live)).toEqual(HELD);
  });

  it('the active Optional workspace and a policy that does not ask this role: sent', () => {
    expect(outboxSendDecision({ organizationId: 'org-optional', userId: 'u1' }, live)).toMatchObject({
      send: true,
      orgId: 'org-optional',
    });
    expect(outboxSendDecision({ organizationId: 'org-admins', userId: 'u1' }, live)).toMatchObject({
      send: true,
      orgId: 'org-admins',
    });
  });

  it('a legacy row is decided by the workspace it would be sent under', () => {
    expect(
      outboxSendDecision({ organizationId: null, userId: null }, { ...live, orgId: 'org-all' }),
    ).toEqual(HELD);
    expect(outboxSendDecision({ organizationId: null, userId: null }, live)).toMatchObject({ send: true });
  });

  it('a hidden workspace row or an unknown answer is not a hold: the drain rule keeps a refusal', () => {
    expect(outboxSendDecision({ organizationId: 'org-hidden', userId: 'u1' }, live)).toMatchObject({
      send: true,
    });
    resetSetUpInputsForTests();
    expect(outboxSendDecision({ organizationId: 'org-all', userId: 'u1' }, live)).toMatchObject({
      send: true,
    });
  });

  it('once the account has a verified authenticator the same row goes, once', () => {
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
    expect(outboxSendDecision({ organizationId: 'org-all', userId: 'u1' }, live)).toEqual({
      send: true,
      orgId: 'org-all',
      userId: 'u1',
      adopt: false,
    });
  });

  it('decided after whose row it is: another account and a code still owed come first', () => {
    expect(outboxSendDecision({ organizationId: 'org-all', userId: 'u2' }, live)).toEqual({
      send: false,
      reason: 'other-account',
    });
    expect(
      outboxSendDecision({ organizationId: 'org-all', userId: 'u1' }, { ...live, stepUpOwed: true }),
    ).toEqual({ send: false, reason: 'step-up-owed' });
  });

  it('heldForSetUp says the same for a row, for the count drain to settle nothing it holds', () => {
    expect(heldForSetUp({ organizationId: 'org-all', userId: 'u1' }, live)).toBe(true);
    expect(heldForSetUp({ organizationId: 'org-optional', userId: 'u1' }, live)).toBe(false);
    expect(heldForSetUp({ organizationId: null, userId: 'u1' }, { ...live, orgId: 'org-all' })).toBe(true);
    expect(heldForSetUp({ organizationId: 'org-all', userId: 'u1' }, { ...live, userId: null })).toBe(false);
    // Only the live account's own rows (and legacy ones) are held for its
    // set-up: another account's row takes the path it always took.
    expect(heldForSetUp({ organizationId: 'org-all', userId: 'u2' }, live)).toBe(false);
    expect(heldForSetUp({ organizationId: 'org-all', userId: null }, live)).toBe(true);
  });
});

describe('the SQL fragments are the same rule as isOwnedBy, for every row and every live user', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('create table pending_actions (id integer primary key, user_id text)');
  const rowUsers = [null, 'u1', 'u2'];
  rowUsers.forEach((u, i) =>
    db.prepare('insert into pending_actions (id, user_id) values (?, ?)').run(i + 1, u),
  );

  const ids = (where: string, live: string | null) =>
    (
      db.prepare(`select id from pending_actions where ${where} order by id`).all(live) as {
        id: number;
      }[]
    ).map((r) => r.id);

  it.each([null, 'u1', 'u2'])('live user %s', (liveUser) => {
    const owned = rowUsers.flatMap((u, i) => (isOwnedBy({ userId: u }, liveUser) ? [i + 1] : []));
    const held = rowUsers.flatMap((u, i) => (isOwnedBy({ userId: u }, liveUser) ? [] : [i + 1]));
    expect(ids(OWNED_BY_USER_SQL, liveUser)).toEqual(owned);
    // HELD is the exact complement (null-safe), the signed-out case included.
    expect(ids(HELD_FOR_OTHER_SQL, liveUser)).toEqual(held);
  });
});

describe('ONE predicate: both drains and every counter use outbox-scope.ts (pattern #26)', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sync = code(read('./sync.ts'));
  const engine = code(read('./cycle-count-sync.ts'));
  const queue = code(read('./queue.ts'));
  const cache = code(read('./cycle-count-cache.ts'));

  const loopBody = (src: string, loopStart: string, end: string) => {
    const start = src.indexOf(loopStart);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf(end, start));
  };

  it('engine 1 decides per row, inside its loop, with the shared predicate', () => {
    // OWNED_BY_USER_SQL too: a full pull keeps an adopted count for this
    // account's queued rows by the same rule (sync.ts, unconfirmed rows).
    expect(sync).toMatch(
      /import \{ OutboxSessionChangedError, OWNED_BY_USER_SQL, outboxSendDecision \} from '\.\/outbox-scope'/,
    );
    const loop = loopBody(sync, 'for (const action of pending)', 'return { ok, failed, rejected }');
    expect(loop).toContain('outboxSendDecision(action, await liveOutboxScope())');
    expect(loop).toMatch(/asUserId: decision\.userId/);
    expect(loop).toMatch(/orgId: decision\.orgId/);
  });

  it('engine 2 decides per row, inside its loop, with the same predicate', () => {
    expect(engine).toMatch(
      /outboxSendDecision,\s+REPLACED_BY_LATER_COUNT,\s+\} from '\.\/outbox-scope'/,
    );
    const loop = loopBody(
      engine,
      'for (const row of send)',
      'this.pendingCount = await totalPendingCount()',
    );
    expect(loop).toContain('outboxSendDecision(row, await liveOutboxScope())');
    expect(loop).toMatch(/asUserId: decision\.userId/);
  });

  it('neither drain carries its own user or org comparison', () => {
    for (const src of [sync, engine]) {
      expect(src).not.toMatch(/\.userId\s*[!=]==/);
      expect(src).not.toMatch(/user_id\s*(=|is)/);
    }
  });

  it('every owner filter in SQL is the shared fragment, never a hand-written copy', () => {
    for (const src of [queue, cache]) {
      expect(src).not.toMatch(/user_id is null or user_id/);
      expect(src).not.toMatch(/user_id is not null and user_id/);
    }
    for (const [src, fns] of [
      [cache, ['pendingCountFor', 'totalPendingCount']],
      [queue, ['pendingCount', 'countRejected', 'listRejected', 'clearRejected']],
    ] as const) {
      for (const fn of fns) {
        const body = src.slice(src.indexOf(`export async function ${fn}(`)).split('\n}\n')[0] ?? '';
        expect(body, fn).toContain('${OWNED_BY_USER_SQL}');
        expect(body, fn).toContain('liveOutboxScope()');
      }
    }
    for (const fn of ['listHeld', 'countHeld']) {
      const body =
        queue.slice(queue.indexOf(`export async function ${fn}(`)).split('\n}\n')[0] ?? '';
      expect(body, fn).toContain('${HELD_FOR_OTHER_SQL}');
    }
  });
});
