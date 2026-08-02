import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit writer stays BEST-EFFORT — a failed insert must never break the
 * god-mode action it is logging — but it must stop being SILENT. The owner's
 * brief requires every disable, revocation and re-enable to be auditable, so a
 * caller that cares (account-status.ts) has to be able to tell that the row did
 * not land and report the operation as partial.
 */

const insert = vi.fn();
const reportError = vi.fn(async (..._args: unknown[]) => {});

/** Per-table results for the read paths, keyed by table name. */
const selectResult = new Map<string, { data: unknown; error: { message: string } | null }>();
/** Every `.in(column, values)` the reads issued, so the batching can be pinned. */
const inCalls: Array<{ table: string; column: string; values: unknown[] }> = [];

vi.mock('@/lib/error-reporter', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const result = () => selectResult.get(table) ?? { data: [], error: null };
      // A thenable chain: every builder method returns `this`, and awaiting it
      // resolves to the table's canned result — the shape postgrest-js presents.
      const builder: Record<string, unknown> = {
        insert: (...a: unknown[]) => insert(...a),
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        in: (column: string, values: unknown[]) => {
          inCalls.push({ table, column, values });
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
  }),
}));

import {
  auditDetailReason,
  auditDetailSuperseded,
  listPlatformAudit,
  recordPlatformAudit,
} from './audit';

const INPUT = {
  actorUserId: '22222222-2222-2222-2222-222222222222',
  actorEmail: 'god@stockpilotusa.com',
  action: 'user_disabled' as const,
  targetUserId: '11111111-1111-1111-1111-111111111111',
};

describe('recordPlatformAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insert.mockResolvedValue({ error: null });
  });

  it('returns true when the row lands', async () => {
    await expect(recordPlatformAudit(INPUT)).resolves.toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_disabled', target_user_id: INPUT.targetUserId }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it('returns FALSE instead of swallowing a rejected insert', async () => {
    // e.g. the 0308 CHECK constraint refusing an action value that the
    // migration has not been pushed for yet.
    insert.mockResolvedValue({ error: { message: 'violates check constraint' } });

    await expect(recordPlatformAudit(INPUT)).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('returns false rather than throwing when the client blows up', async () => {
    insert.mockRejectedValue(new Error('connection reset'));

    await expect(recordPlatformAudit(INPUT)).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

/**
 * The audit screen is the god admin's REVIEW surface, and the owner's brief
 * requires a disable and a re-enable to be reviewable there — not merely
 * recorded. The row already carries `target_user_id` and the composed reason in
 * `detail`; the read simply never surfaced either, so an operator auditing a
 * disable could see that SOMEONE was disabled by SOMEONE, and nothing else.
 *
 * The target's email is resolved here rather than denormalised into the audit
 * row, because a uuid is not reviewable by a human and the row is append-only:
 * copying an email into it would freeze a value that can legitimately change.
 */
describe('listPlatformAudit', () => {
  const ACTOR = '22222222-2222-2222-2222-222222222222';
  const TARGET_A = '11111111-1111-1111-1111-111111111111';
  const TARGET_B = '33333333-3333-3333-3333-333333333333';

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    actor_email: 'god@stockpilotusa.com',
    action: 'user_disabled',
    target_organization_id: null,
    target_user_id: TARGET_A,
    detail: { reason: 'Security investigation — shared credentials' },
    created_at: '2026-07-31T20:24:55.000Z',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    selectResult.clear();
    inCalls.length = 0;
  });

  it('resolves the target user email so the screen can name who was disabled', async () => {
    selectResult.set('platform_admin_audit', { data: [row()], error: null });
    selectResult.set('user_profiles', {
      data: [{ id: TARGET_A, email: 'member.user@local.example.com' }],
      error: null,
    });

    const rows = await listPlatformAudit();

    expect(rows[0]).toMatchObject({
      targetUserId: TARGET_A,
      targetUserEmail: 'member.user@local.example.com',
      detail: { reason: 'Security investigation — shared credentials' },
    });
  });

  it('resolves every distinct target in ONE batched lookup, not one per row', async () => {
    selectResult.set('platform_admin_audit', {
      data: [
        row({ id: 'a1', target_user_id: TARGET_A }),
        row({ id: 'a2', target_user_id: TARGET_B }),
        row({ id: 'a3', target_user_id: TARGET_A }),
        row({ id: 'a4', target_user_id: null }),
      ],
      error: null,
    });
    selectResult.set('user_profiles', {
      data: [
        { id: TARGET_A, email: 'a@example.com' },
        { id: TARGET_B, email: 'b@example.com' },
      ],
      error: null,
    });

    const rows = await listPlatformAudit();

    expect(inCalls).toHaveLength(1);
    expect(inCalls[0]!.table).toBe('user_profiles');
    expect([...inCalls[0]!.values].sort()).toEqual([TARGET_A, TARGET_B].sort());
    expect(rows.map((r) => r.targetUserEmail)).toEqual([
      'a@example.com',
      'b@example.com',
      'a@example.com',
      null,
    ]);
  });

  it('does not look anyone up when no row names a target user', async () => {
    selectResult.set('platform_admin_audit', {
      data: [row({ action: 'viewed_org', target_user_id: null })],
      error: null,
    });

    const rows = await listPlatformAudit();

    expect(inCalls).toHaveLength(0);
    expect(rows[0]!.targetUserEmail).toBeNull();
  });

  it('still returns the rows when the email lookup fails — the uuid is the fallback', async () => {
    // A degraded name column must never blank out the audit trail itself. The
    // page renders the uuid when there is no email, which is still reviewable.
    selectResult.set('platform_admin_audit', { data: [row()], error: null });
    selectResult.set('user_profiles', { data: null, error: { message: 'timeout' } });

    const rows = await listPlatformAudit();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetUserId).toBe(TARGET_A);
    expect(rows[0]!.targetUserEmail).toBeNull();
  });

  it('surfaces a failed audit READ rather than rendering an empty trail', async () => {
    selectResult.set('platform_admin_audit', { data: null, error: { message: 'boom' } });

    await expect(listPlatformAudit()).rejects.toThrow('boom');
  });

  it('does not confuse the actor with the target', async () => {
    selectResult.set('platform_admin_audit', {
      data: [row({ target_user_id: TARGET_A, actor_email: 'god@stockpilotusa.com' })],
      error: null,
    });
    selectResult.set('user_profiles', {
      data: [{ id: TARGET_A, email: 'member.user@local.example.com' }],
      error: null,
    });

    const rows = await listPlatformAudit();

    expect(rows[0]!.actorEmail).toBe('god@stockpilotusa.com');
    expect(rows[0]!.targetUserEmail).toBe('member.user@local.example.com');
    expect(inCalls[0]!.values).not.toContain(ACTOR);
  });
});

/**
 * What the REASON cell renders. `detail` is free-form jsonb written by many
 * callers, so the cell needs one predicate rather than an inline `detail.reason
 * as string` that would print `[object Object]` or `undefined` the first time a
 * caller writes something else.
 */
describe('auditDetailReason', () => {
  it('reads the composed reason a disable stores', () => {
    expect(auditDetailReason({ reason: 'Security investigation — shared credentials' })).toBe(
      'Security investigation — shared credentials',
    );
  });

  it('trims, and treats blank as absent', () => {
    expect(auditDetailReason({ reason: '  Policy violation  ' })).toBe('Policy violation');
    expect(auditDetailReason({ reason: '   ' })).toBeNull();
    expect(auditDetailReason({ reason: '' })).toBeNull();
  });

  it('returns null for a detail that carries no reason — a re-enable', () => {
    expect(auditDetailReason({ ban_cleared: true, already_active: false })).toBeNull();
    expect(auditDetailReason({})).toBeNull();
  });

  it('never renders a non-string reason', () => {
    expect(auditDetailReason({ reason: { category: 'other' } })).toBeNull();
    expect(auditDetailReason({ reason: 42 })).toBeNull();
    expect(auditDetailReason({ reason: null })).toBeNull();
  });
});

/**
 * `action` alone (e.g. 'user_disabled') cannot tell a real disable apart
 * from a press that lost the race to a peer admin's concurrent transition —
 * both write the SAME action value (see account-status.ts CONVERGENCE).
 * `detail.superseded` is the only place that distinction lives, so a reader
 * needs the same one-predicate treatment `auditDetailReason` already gives
 * `detail.reason` — otherwise every consumer re-derives its own
 * `detail.superseded === true` and one of them eventually gets it wrong.
 */
describe('auditDetailSuperseded', () => {
  it('reads true off a superseded disable/re-enable row', () => {
    expect(auditDetailSuperseded({ superseded: true, resulting_disabled: false })).toBe(true);
  });

  it('reads false off an ordinary row', () => {
    expect(auditDetailSuperseded({ superseded: false })).toBe(false);
  });

  it('treats a missing or non-boolean value as not superseded', () => {
    expect(auditDetailSuperseded({})).toBe(false);
    expect(auditDetailSuperseded({ superseded: 'true' })).toBe(false);
    expect(auditDetailSuperseded({ superseded: 1 })).toBe(false);
    expect(auditDetailSuperseded({ superseded: null })).toBe(false);
  });
});
