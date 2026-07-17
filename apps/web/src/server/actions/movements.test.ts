import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// Mutable session state so per-test role + AAL overrides work (mirrors
// custom-fields.test.ts / nav-settings.test.ts).
const sessionState = {
  role: 'manager' as 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  mfaRequired: false,
  mfaSatisfied: true,
};

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null } = { stub: null };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => stubHolder.stub!.client),
}));

vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: 'org-1',
      userId: 'user-1',
      role: sessionState.role,
      supabase: stubHolder.stub!.client,
      mfaRequired: sessionState.mfaRequired,
      mfaSatisfied: sessionState.mfaSatisfied,
      enabledModules: new Set(),
    })),
  };
});

import { audit } from '@/server/services/audit';

import { editMovementNoteAction } from './movements';

const MOVEMENT_ID = '11111111-1111-1111-1111-111111111111';
const ITEM_ID = '22222222-2222-2222-2222-222222222222';

/** Stub the table-returning RPC's one-row result (item_id + pre-update note). */
function stubWith(rpcResult: {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}) {
  stubHolder.stub = makeSupabaseStub({
    'rpc:edit_movement_note': { data: rpcResult.data ?? null, error: rpcResult.error ?? null },
  });
}

/** First payload passed to the mocked audit() call. */
function auditPayload(): Record<string, unknown> {
  return (audit as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.role = 'manager';
  sessionState.mfaRequired = false;
  sessionState.mfaSatisfied = true;
  stubWith({ data: [{ item_id: ITEM_ID, old_note: 'old note' }] });
});

describe('editMovementNoteAction', () => {
  it('rejects a viewer (no permission) as forbidden and never calls the RPC', async () => {
    sessionState.role = 'viewer';
    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: 'nope' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    // Gate fired BEFORE the ledger was touched — the append-only invariant.
    expect(stubHolder.stub!.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects staff without the granted permission and never calls the RPC', async () => {
    sessionState.role = 'staff';
    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: 'nope' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(stubHolder.stub!.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('calls the RPC with the right args and audits old→new for a manager', async () => {
    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: '  new note  ' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.note).toBe('new note');

    // RPC called once with the exact param names the SQL function declares.
    expect(stubHolder.stub!.rpcCalls).toHaveLength(1);
    expect(stubHolder.stub!.rpcCalls[0]).toEqual({
      name: 'edit_movement_note',
      args: { p_movement_id: MOVEMENT_ID, p_note: '  new note  ' },
    });

    // Audit row keyed to the ITEM so it lands on the item Activity feed +
    // global audit; before/after carry the note diff.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(auditPayload()).toMatchObject({
      event: 'stock_movement.note_edited',
      entityType: 'inventory_item',
      entityId: ITEM_ID,
      before: { notes: 'old note' },
      after: { notes: 'new note' },
      reason: 'movement_note_edited',
      extra: { movement_id: MOVEMENT_ID },
    });
  });

  it('records after.notes = null when the note is cleared', async () => {
    stubWith({ data: [{ item_id: ITEM_ID, old_note: 'old note' }] });
    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: '   ' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.note).toBeNull();
    expect(auditPayload()).toMatchObject({ after: { notes: null } });
  });

  it('maps the RPC 42501 (SQL gate) to a forbidden result and does not audit', async () => {
    stubWith({ data: null, error: { code: '42501', message: 'insufficient_privilege' } });
    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    // RPC WAS attempted (app gate passed for the manager) but no audit on failure.
    expect(stubHolder.stub!.rpcCalls).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps the RPC 22023 (system-managed receipt_line note) to a validation_error and does not audit', async () => {
    stubWith({
      data: null,
      error: { code: '22023', message: 'movement note is system-managed and cannot be edited' },
    });
    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: 'overwrite' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('validation_error');
      expect(res.error.message).toMatch(/managed by the system/i);
    }
    // RPC WAS attempted (app gate passed for the manager) but no audit on failure.
    expect(stubHolder.stub!.rpcCalls).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a malformed movementId as validation_error before any RPC', async () => {
    const res = await editMovementNoteAction({ movementId: 'not-a-uuid', note: 'x' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(stubHolder.stub!.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
