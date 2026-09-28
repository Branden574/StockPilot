import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The escalation form's glue (F1-5). What must hold:
 *   - it saves through escalateExceptionAction, for THIS exception, with only
 *     the four fields an escalation saves (the server takes the item and the
 *     location from the exception), never the plain create action;
 *   - saved: the request's review screen (?review=1); NOTHING opens from
 *     here (no window, no mailto): the email opens only when the person taps
 *     it on the review screen;
 *   - already escalated: the request is opened only for a reader who can open
 *     it; anyone else goes back to the exception, which says so;
 *   - any other refusal is shown in the form and navigates nowhere.
 */

const { escalateAction, createAction, push, toastInfo } = vi.hoisted(() => ({
  escalateAction: vi.fn(),
  createAction: vi.fn(),
  push: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/exceptions', () => ({ escalateExceptionAction: escalateAction }));
vi.mock('@/server/actions/maintenance-requests', () => ({ createMaintenanceRequestAction: createAction }));

import { EscalateRequestClient } from './escalate-request-client';

const OCC = '11111111-1111-4111-8111-111111111111';
const REQ = '44444444-4444-4444-8444-444444444444';
const DEFAULTS = {
  subject: 'Inventory issue: Atlas (A1)',
  description: 'Stale in Staging: 12 units in Staging for at least 9 days. Location: Staging. Ref EX-000042.',
  priority: 'normal' as const,
  category: 'Inventory or equipment',
};

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => openSpy.mockRestore());

async function save() {
  render(<EscalateRequestClient occurrenceId={OCC} defaults={DEFAULTS} categories={['Inventory or equipment', 'Other']} />);
  await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
}

describe('EscalateRequestClient', () => {
  it('saves through the escalate action with only the four fields, then lands on the review screen, opening nothing', async () => {
    escalateAction.mockResolvedValue({
      ok: true,
      id: REQ,
      requestNumber: 14,
      reference: 'MR-2026-000014',
      createdAt: '2026-09-27T12:00:00Z',
    });
    await save();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/maintenance/${REQ}?review=1`));
    expect(escalateAction).toHaveBeenCalledTimes(1);
    expect(escalateAction).toHaveBeenCalledWith(OCC, {
      subject: DEFAULTS.subject,
      description: DEFAULTS.description,
      priority: 'normal',
      category: 'Inventory or equipment',
    });
    expect(createAction).not.toHaveBeenCalled();
    // The composer never opens by itself.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('only the escalation fields are shown: no site, phone, room or access fields to be silently dropped', () => {
    render(<EscalateRequestClient occurrenceId={OCC} defaults={DEFAULTS} categories={['Inventory or equipment']} />);
    expect(screen.queryByLabelText('Site')).toBeNull();
    expect(screen.queryByLabelText('Contact phone (optional)')).toBeNull();
    expect(screen.queryByLabelText('Room or area')).toBeNull();
    expect(screen.queryByLabelText('Additional access instructions')).toBeNull();
    expect(screen.getByLabelText('What is the issue?')).toHaveValue(DEFAULTS.subject);
  });

  it('already escalated to a request this reader can open: opens that request, says so, saves nothing', async () => {
    escalateAction.mockResolvedValue({
      error: {
        message: 'This exception is already escalated to MR-2026-000009. Opening that request.',
        reason: 'already_escalated',
        requestId: REQ,
        reference: 'MR-2026-000009',
        requestVisible: true,
      },
    });
    await save();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/maintenance/${REQ}`));
    expect(toastInfo).toHaveBeenCalledWith('This exception is already escalated to MR-2026-000009. Opening that request.');
    expect(push).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  // Mutation caught: every duplicate sent to the request (a reader who cannot
  // open it lands on a 404).
  it('already escalated to a request this reader cannot open: back to the exception, with why', async () => {
    escalateAction.mockResolvedValue({
      error: {
        message: 'This exception is already escalated to MR-2026-000009. Opening that request.',
        reason: 'already_escalated',
        requestId: REQ,
        reference: 'MR-2026-000009',
        requestVisible: false,
      },
    });
    await save();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/dashboard/exceptions/${OCC}`));
    expect(push).not.toHaveBeenCalledWith(`/dashboard/maintenance/${REQ}`);
    expect(toastInfo).toHaveBeenCalledWith(
      'Already escalated to MR-2026-000009. A new request can be made only if that one is cancelled.',
    );
  });

  it('any other refusal is shown in the form and goes nowhere', async () => {
    escalateAction.mockResolvedValue({
      error: {
        message: 'This exception is being escalated right now. Try again in a minute.',
        reason: 'escalation_in_progress',
        retryable: true,
      },
    });
    await save();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This exception is being escalated right now. Try again in a minute.',
    );
    expect(push).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
