import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Exceptions server actions are thin wrappers over the service the phone's
 * routes use. Pinned here: a bad id never reaches the service, app-authored
 * reasons pass through, and raw database text never does.
 */

const { act, requestCheck, recountStart, list, fetchCountAssignees, withContextMock } = vi.hoisted(() => ({
  act: vi.fn(),
  requestCheck: vi.fn(),
  recountStart: vi.fn(),
  list: vi.fn(),
  fetchCountAssignees: vi.fn(),
  withContextMock: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/exception-occurrences', () => ({
  ExceptionOccurrencesService: class {
    act = act;
    requestCheck = requestCheck;
    list = list;
  },
}));
vi.mock('@/server/lib/count-assignees', () => ({ fetchCountAssignees }));
vi.mock('@/server/services/exception-recount', () => ({
  ExceptionRecountService: class {
    start = recountStart;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';

import {
  actOnExceptionAction,
  listCountAssigneesAction,
  listItemRecountTargetsAction,
  listItemsRecountTargetsAction,
  requestExceptionCheckAction,
  startRecountAction,
} from './exceptions';

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  withContextMock.mockResolvedValue({ organizationId: 'org-1', role: 'manager', supabase: { tag: 'caller' } });
});

describe('actOnExceptionAction', () => {
  it('passes the action through and revalidates the list and the occurrence', async () => {
    act.mockResolvedValue({ id: ID });
    await expect(
      actOnExceptionAction(ID, { action: 'note', note: 'checking rack', clientEventId: 'ce-1' }),
    ).resolves.toEqual({ ok: true });
    expect(act).toHaveBeenCalledWith(ID, { action: 'note', note: 'checking rack', clientEventId: 'ce-1' });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/exceptions');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/exceptions/${ID}`);
  });

  it('refuses a malformed id without calling the service', async () => {
    const res = await actOnExceptionAction('nope', { action: 'acknowledge' });
    expect(res).toEqual({ error: { message: 'That exception id is not valid.', reason: null } });
    expect(act).not.toHaveBeenCalled();
  });

  it('forwards an app-authored reason (a resolved occurrence)', async () => {
    act.mockRejectedValue(
      new ServiceError('conflict', 'This exception has already been resolved.', { reason: 'occurrence_resolved' }),
    );
    await expect(actOnExceptionAction(ID, { action: 'acknowledge' })).resolves.toEqual({
      error: { message: 'This exception has already been resolved.', reason: 'occurrence_resolved' },
    });
  });

  it('never forwards raw database text', async () => {
    act.mockRejectedValue(new ServiceError('internal_error', 'relation "x" violates policy', { code: '42P01' }));
    await expect(actOnExceptionAction(ID, { action: 'acknowledge' })).resolves.toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});

describe('requestExceptionCheckAction', () => {
  it('returns the scheduling answer at once', async () => {
    requestCheck.mockResolvedValue({ scheduled: true, lastSyncedAt: null, retryAfterSeconds: 0 });
    await expect(requestExceptionCheckAction()).resolves.toEqual({
      ok: true,
      scheduled: true,
      lastSyncedAt: null,
      retryAfterSeconds: 0,
    });
  });

  it('a staff member is refused with the service message', async () => {
    requestCheck.mockRejectedValue(new ServiceError('forbidden', 'Only a manager can run a check now.'));
    await expect(requestExceptionCheckAction()).resolves.toEqual({
      error: { message: 'Only a manager can run a check now.', reason: null },
    });
  });
});

describe('startRecountAction', () => {
  it('passes the selection and key through, and revalidates Exceptions and counts', async () => {
    recountStart.mockResolvedValue({ cycleCountId: 'cc-1', created: true });
    await expect(
      startRecountAction({ occurrenceIds: [ID], itemIds: null, assignedTo: null, idempotencyKey: 'tap-1' }),
    ).resolves.toEqual({ ok: true, result: { cycleCountId: 'cc-1', created: true } });
    expect(recountStart).toHaveBeenCalledWith({
      occurrenceIds: [ID],
      itemIds: null,
      assignedTo: null,
      idempotencyKey: 'tap-1',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/exceptions');
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/cycle-counts');
  });

  it('says when a refusal is safe to retry with the same key', async () => {
    recountStart.mockRejectedValue(
      new ServiceError('conflict', 'Try again in a moment.', { reason: 'recount_busy', retryable: true }),
    );
    await expect(startRecountAction({ occurrenceIds: [ID] })).resolves.toEqual({
      error: { message: 'Try again in a moment.', reason: 'recount_busy', retryable: true },
    });
    recountStart.mockRejectedValue(
      new ServiceError('conflict', 'Already used.', { reason: 'idempotency_conflict' }),
    );
    await expect(startRecountAction({ occurrenceIds: [ID] })).resolves.toEqual({
      error: { message: 'Already used.', reason: 'idempotency_conflict' },
    });
  });

  it('never forwards raw database text', async () => {
    recountStart.mockRejectedValue(new ServiceError('internal_error', 'relation secret_table'));
    const res = await startRecountAction({ occurrenceIds: [ID] });
    expect(JSON.stringify(res)).not.toMatch(/secret_table/);
    expect(res).toEqual({ error: { message: 'Something went wrong. Please try again.', reason: null } });
  });
});

describe('listCountAssigneesAction (the recount dialog\'s Assign to)', () => {
  it('returns names only, from the shared member source on the caller\'s own client', async () => {
    fetchCountAssignees.mockResolvedValue([
      { id: 'u1', name: 'Ana', email: 'ana@example.com' },
      { id: 'u2', name: 'Ben', email: 'ben@example.com' },
    ]);
    await expect(listCountAssigneesAction()).resolves.toEqual({
      ok: true,
      members: [
        { id: 'u1', name: 'Ana' },
        { id: 'u2', name: 'Ben' },
      ],
    });
    expect(fetchCountAssignees).toHaveBeenCalledWith({ tag: 'caller' }, 'org-1');
  });

  // Mutation caught: the permission check removed.
  it('refuses a reader without cycle_counts:assign, without reading members', async () => {
    withContextMock.mockResolvedValue({ organizationId: 'org-1', role: 'staff', supabase: {} });
    await expect(listCountAssigneesAction()).resolves.toEqual({
      error: { message: 'Only a manager can assign counts.', reason: null },
    });
    expect(fetchCountAssignees).not.toHaveBeenCalled();
  });

  it('a failed member read is a failure, never an empty list', async () => {
    fetchCountAssignees.mockRejectedValue(new Error('organization_members read failed: boom'));
    await expect(listCountAssigneesAction()).resolves.toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});

describe('listItemRecountTargetsAction (Count this item)', () => {
  const ITEM = '22222222-2222-4222-8222-222222222222';

  it('returns the item\'s open exceptions a recount can settle', async () => {
    list.mockResolvedValue({
      canRecount: true,
      occurrences: [
        { id: 'o1', canRecount: true },
        { id: 'o2', canRecount: false },
      ],
    });
    await expect(listItemRecountTargetsAction(ITEM)).resolves.toEqual({
      ok: true,
      canRecount: true,
      occurrenceIds: ['o1'],
    });
    expect(list).toHaveBeenCalledWith({ status: 'open', itemId: ITEM });
  });

  it('refuses a malformed item id without reading', async () => {
    const res = await listItemRecountTargetsAction('nope');
    expect(res).toEqual({ error: { message: 'That item id is not valid.', reason: null } });
    expect(list).not.toHaveBeenCalled();
  });

  it('a failed read is a failure, never "no exceptions"', async () => {
    list.mockRejectedValue(new ServiceError('internal_error', 'boom'));
    await expect(listItemRecountTargetsAction(ITEM)).resolves.toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});

describe('listItemsRecountTargetsAction (Recount items here, F1-3)', () => {
  const A = '22222222-2222-4222-8222-222222222222';
  const B = '33333333-3333-4333-8333-333333333333';
  const OTHER = '44444444-4444-4444-8444-444444444444';

  it("returns the open exceptions a recount can settle, for THESE items only", async () => {
    list.mockResolvedValue({
      canRecount: true,
      recountUnavailableReason: null,
      truncated: false,
      occurrences: [
        { id: 'o1', itemId: A, canRecount: true },
        { id: 'o2', itemId: A, canRecount: false },
        { id: 'o3', itemId: OTHER, canRecount: true },
        { id: 'o4', itemId: B.toUpperCase(), canRecount: true },
      ],
    });
    await expect(listItemsRecountTargetsAction([A, B])).resolves.toEqual({
      ok: true,
      canRecount: true,
      recountUnavailableReason: null,
      occurrenceIds: ['o1', 'o4'],
      truncated: false,
    });
    expect(list).toHaveBeenCalledWith({ status: 'open' });
  });

  it('says when the open list stopped at its cap (some may be left unlinked), and passes a refusal reason through', async () => {
    list.mockResolvedValue({
      canRecount: false,
      recountUnavailableReason: 'module_disabled',
      truncated: true,
      occurrences: [],
    });
    await expect(listItemsRecountTargetsAction([A])).resolves.toMatchObject({
      canRecount: false,
      recountUnavailableReason: 'module_disabled',
      truncated: true,
    });
  });

  it.each([
    ['no ids', []],
    ['a malformed id', [A, 'nope']],
    ['more than a recount can hold', Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)],
  ])('refuses %s without reading', async (_what, ids) => {
    const res = await listItemsRecountTargetsAction(ids as string[]);
    expect(res).toEqual({ error: { message: 'Those item ids are not valid.', reason: null } });
    expect(list).not.toHaveBeenCalled();
  });

  it('a failed read is a failure, never "no exceptions"', async () => {
    list.mockRejectedValue(new ServiceError('internal_error', 'boom'));
    await expect(listItemsRecountTargetsAction([A])).resolves.toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});
