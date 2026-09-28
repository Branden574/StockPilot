import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * escalateExceptionAction (F1-5) is a thin wrapper over the service the
 * phone's escalate route uses. Pinned here: a bad id never reaches the
 * service; a duplicate answers the linked request's id and handle (the form
 * opens it); the module-off answer names itself; raw database text never
 * crosses; a success revalidates the exception and the maintenance list.
 */

const { escalate, withContextMock } = vi.hoisted(() => ({ escalate: vi.fn(), withContextMock: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/exception-escalation', () => ({
  ExceptionEscalationService: class {
    escalate = escalate;
  },
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: withContextMock,
}));

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';

import { escalateExceptionAction } from './exceptions';

const ID = '11111111-1111-4111-8111-111111111111';
const REQ = '44444444-4444-4444-8444-444444444444';
const VALUES = { subject: 'Inventory issue: Atlas (A1)', description: 'Label will not lead to the stock. Ref EX-000042.' };

beforeEach(() => {
  vi.clearAllMocks();
  withContextMock.mockResolvedValue({ organizationId: 'org-1', role: 'staff', supabase: { tag: 'caller' } });
});

describe('escalateExceptionAction', () => {
  it('passes the values through and answers the saved request; revalidates the exception and maintenance', async () => {
    escalate.mockResolvedValue({ id: REQ, requestNumber: 14, reference: 'MR-2026-000014', createdAt: '2026-09-27T12:00:00Z' });
    await expect(escalateExceptionAction(ID, VALUES)).resolves.toEqual({
      ok: true,
      id: REQ,
      requestNumber: 14,
      reference: 'MR-2026-000014',
      createdAt: '2026-09-27T12:00:00Z',
    });
    expect(escalate).toHaveBeenCalledWith(ID, VALUES);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/exceptions');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/exceptions/${ID}`);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/maintenance');
  });

  it('refuses a malformed id without calling the service', async () => {
    await expect(escalateExceptionAction('nope', VALUES)).resolves.toEqual({
      error: { message: 'That exception id is not valid.', reason: null },
    });
    expect(escalate).not.toHaveBeenCalled();
  });

  it('a duplicate answers the linked request\'s id and handle, so the form opens it', async () => {
    escalate.mockRejectedValue(
      new ServiceError('conflict', 'This exception is already escalated to MR-2026-000009. Opening that request.', {
        reason: 'already_escalated',
        requestId: REQ,
        requestNumber: 9,
        reference: 'MR-2026-000009',
      }),
    );
    await expect(escalateExceptionAction(ID, VALUES)).resolves.toEqual({
      error: {
        message: 'This exception is already escalated to MR-2026-000009. Opening that request.',
        reason: 'already_escalated',
        requestId: REQ,
        reference: 'MR-2026-000009',
      },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('module off names itself; in progress is retryable', async () => {
    escalate.mockRejectedValueOnce(new ServiceError('module_disabled', 'Module not enabled for this organization: maintenance_requests'));
    expect(await escalateExceptionAction(ID, VALUES)).toEqual({
      error: { message: 'Module not enabled for this organization: maintenance_requests', reason: 'module_disabled' },
    });
    escalate.mockRejectedValueOnce(
      new ServiceError('conflict', 'This exception is being escalated right now. Try again in a minute.', {
        reason: 'escalation_in_progress',
        retryable: true,
      }),
    );
    expect(await escalateExceptionAction(ID, VALUES)).toEqual({
      error: {
        message: 'This exception is being escalated right now. Try again in a minute.',
        reason: 'escalation_in_progress',
        retryable: true,
      },
    });
  });

  it('never forwards raw database text', async () => {
    escalate.mockRejectedValue(new ServiceError('internal_error', 'relation "maintenance_requests" violates policy'));
    expect(await escalateExceptionAction(ID, VALUES)).toEqual({
      error: { message: 'Something went wrong. Please try again.', reason: null },
    });
  });
});
