import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const stubHolder: { stub: ReturnType<typeof makeSupabaseStub> | null; org: string } = {
  stub: null,
  org: 'org-A',
};

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: vi.fn(async () => ({
      organizationId: stubHolder.org,
      userId: 'u-in-both',
      role: 'manager',
      supabase: stubHolder.stub!.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(),
    })),
  };
});

import { revalidatePath } from 'next/cache';

import { audit } from '@/server/services/audit';

import { editMovementNoteAction } from './movements';

/**
 * S39: a movement of organization B, its note edited from the Movements page
 * left open after the person switched to organization A. edit_movement_note
 * decides on the MOVEMENT's own organization, so B's note changed while the
 * audit row (the old and the new note text) landed in A. The movement is now
 * read in A first; a miss answers 'Movement not found.', the phone route's
 * sentence, and nothing runs.
 */

const MOVEMENT_ID = '11111111-1111-4111-8111-1111111111b1';
const ITEM_ID = '22222222-2222-4222-8222-2222222222b1';

beforeEach(() => {
  vi.clearAllMocks();
  stubHolder.stub = makeSupabaseStub({
    'stock_movements.select': servedLikePostgrest([{ id: MOVEMENT_ID, organization_id: 'org-B' }]),
    'rpc:edit_movement_note': { data: [{ item_id: ITEM_ID, old_note: 'old note' }], error: null },
  });
});

describe('editMovementNoteAction: a movement of another organization is not found', () => {
  it('editing a note on a movement that is not in A changes nothing and records nothing', async () => {
    stubHolder.org = 'org-A';

    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: 'new note' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('not_found');
      expect(res.error.message).toBe('Movement not found.');
    }
    expect(stubHolder.stub!.chainArgsAll.get('stock_movements.select')?.[0]).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-A'],
        ['id', MOVEMENT_ID],
      ]),
    );
    expect(stubHolder.stub!.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('working in B, the note is edited once and recorded in B', async () => {
    stubHolder.org = 'org-B';

    const res = await editMovementNoteAction({ movementId: MOVEMENT_ID, note: 'new note' });

    expect(res).toEqual({ ok: true, data: { note: 'new note' } });
    expect(stubHolder.stub!.rpcCalls.map((c) => c.name)).toEqual(['edit_movement_note']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stock_movement.note_edited', entityId: ITEM_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
  });
});
