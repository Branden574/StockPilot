import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  HELD_FOR_OTHER_SQL,
  isOwnedBy,
  outboxSendDecision,
  OWNED_BY_USER_SQL,
} from './outbox-scope';

/**
 * The one scope rule for queued work (S4a, owner decision D4). Pure cases,
 * then proof that the SQL fragments the counters use say exactly what the
 * function the drains use says, then wiring pins that both drains and every
 * counter go through them (recurring pattern #26).
 */

describe('outboxSendDecision', () => {
  const live = { orgId: 'org-b', userId: 'u1' };

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
      outboxSendDecision({ organizationId: null, userId: null }, { orgId: 'org-b', userId: null }),
    ).toEqual({
      send: false,
      reason: 'signed-out',
    });
    expect(
      outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, { orgId: null, userId: null }),
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
    expect(sync).toMatch(
      /import \{ OutboxSessionChangedError, outboxSendDecision \} from '\.\/outbox-scope'/,
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
