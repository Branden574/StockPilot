import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Typed with an explicit rest-parameter signature (`..._args: unknown[]`)
// rather than a zero-arg lambda: TS would otherwise infer a strict 0-arity
// mock, and both the wrapper's `createAction(...args)` spread below and
// `createAction.mock.calls[0][0]` further down need a real tuple type to
// index into.
const createAction = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  id: 'r1',
  requestNumber: 1,
  createdAt: '2026-08-05T16:15:00Z',
}));
vi.mock('@/server/actions/maintenance-requests', () => ({
  createMaintenanceRequestAction: (...args: unknown[]) => createAction(...args),
}));

import { MaintenanceRequestForm } from './maintenance-request-form';

const SITES = [{ id: '44444444-4444-4444-4444-444444444444', name: 'Fresno Learning Center' }];

beforeEach(() => vi.clearAllMocks());

function renderForm(defaults = {}) {
  const onSaved = vi.fn();
  render(
    <MaintenanceRequestForm
      defaults={defaults}
      sites={SITES}
      categories={['Facilities', 'Other']}
      onSaved={onSaved}
    />,
  );
  return { onSaved };
}

describe('MaintenanceRequestForm', () => {
  it('(1) subject is required with the exact label and placeholder from brief section 7', async () => {
    renderForm();
    expect(screen.getByLabelText('What is the issue?')).toHaveAttribute(
      'placeholder',
      'Example: Air conditioner is not working in Room 204',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
    expect(await screen.findByText(/at least 5 characters/i)).toBeInTheDocument();
    expect(createAction).not.toHaveBeenCalled();
  });

  it('(2) description is required with its label and helper text', async () => {
    renderForm();
    expect(screen.getByLabelText('Describe the maintenance issue')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Explain what is happening, when it started, and anything the maintenance team should know before arriving.',
      ),
    ).toBeInTheDocument();
  });

  it('(3) site defaults from the provided default charter', () => {
    renderForm({ charterId: '44444444-4444-4444-4444-444444444444' });
    expect(screen.getByText('Fresno Learning Center')).toBeInTheDocument();
  });

  it('(4) related item prepopulates from launch-point defaults and is shown to the user', () => {
    renderForm({ relatedItemId: '11111111-1111-1111-1111-111111111111' });
    expect(screen.getByText(/linked record/i)).toBeInTheDocument();
  });

  it('(13) there is NO recipient field anywhere — To/CC are not user-editable', () => {
    renderForm();
    expect(screen.queryByLabelText(/to\b/i)).toBeNull();
    expect(screen.queryByDisplayValue('dc4@learn4life.org')).toBeNull();
    expect(screen.queryByDisplayValue('arosas@cvwest.org')).toBeNull();
  });

  it('submits valid values and hands the new id to onSaved', async () => {
    const { onSaved } = renderForm();
    await userEvent.type(screen.getByLabelText('What is the issue?'), 'Air conditioner is not working in Room 204');
    await userEvent.type(
      screen.getByLabelText('Describe the maintenance issue'),
      'Blowing warm air since yesterday afternoon.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('r1'));
    const submitted = createAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(submitted.subject).toBe('Air conditioner is not working in Room 204');
    // No recipient keys can ride along:
    expect('to' in submitted || 'cc' in submitted).toBe(false);
  });

  it('urgent priority shows the safety guidance without claiming emergency coverage', async () => {
    renderForm();
    await userEvent.click(screen.getByLabelText('Priority'));
    await userEvent.click(await screen.findByRole('option', { name: 'Urgent' }));
    expect(
      screen.getByText(
        'For emergencies that put people in danger, follow your site emergency procedures first. StockPilot does not replace them.',
      ),
    ).toBeInTheDocument();
  });

  // --- Additional coverage for the reviewer's binding constraints ---

  it('renders category options exactly from the categories prop, never a hand-typed list', async () => {
    renderForm();
    await userEvent.click(screen.getByLabelText('Category'));
    expect(await screen.findByRole('option', { name: 'Facilities' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Other' })).toBeInTheDocument();
    // The full default twelve must NOT appear — proves the Select maps the
    // `categories` prop rather than importing MAINTENANCE_CATEGORIES itself.
    expect(screen.queryByRole('option', { name: 'Electrical' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Plumbing' })).toBeNull();
  });

  it('rejects a subject under the 5-meaningful-character minimum and never calls the action', async () => {
    renderForm();
    await userEvent.type(screen.getByLabelText('What is the issue?'), 'AC');
    await userEvent.type(
      screen.getByLabelText('Describe the maintenance issue'),
      'A valid description with enough characters.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
    expect(await screen.findByText(/at least 5 characters/i)).toBeInTheDocument();
    expect(createAction).not.toHaveBeenCalled();
  });

  it('preserves intentional line breaks in the description through submit', async () => {
    renderForm();
    await userEvent.type(screen.getByLabelText('What is the issue?'), 'Air conditioner is not working in Room 204');
    const description = screen.getByLabelText('Describe the maintenance issue');
    await userEvent.type(description, 'Line one describing the issue.{Enter}Line two with more detail.');
    await userEvent.click(screen.getByRole('button', { name: 'Save request' }));
    await waitFor(() => expect(createAction).toHaveBeenCalled());
    const submitted = createAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(submitted.description).toBe('Line one describing the issue.\nLine two with more detail.');
  });

  it('a rapid double submit (busy guard) creates only ONE request, not two', async () => {
    // The mocked action stays pending until we resolve it manually, so the
    // first submission is still in flight when the second one fires —
    // exactly the window `if (busy) return` and `disabled={busy}` exist to
    // guard.
    let resolveCreate!: (value: {
      ok: true;
      id: string;
      requestNumber: number;
      createdAt: string;
    }) => void;
    createAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { onSaved } = renderForm();
    await userEvent.type(screen.getByLabelText('What is the issue?'), 'Air conditioner is not working in Room 204');
    await userEvent.type(
      screen.getByLabelText('Describe the maintenance issue'),
      'Blowing warm air since yesterday afternoon.',
    );

    const button = screen.getByRole('button', { name: 'Save request' });
    // Two submits fired back to back, before either has a chance to
    // resolve — the second must be swallowed, not queued as a second call.
    await userEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(createAction).toHaveBeenCalled());
    resolveCreate({ ok: true, id: 'r1', requestNumber: 1, createdAt: '2026-08-05T16:15:00Z' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('r1'));

    expect(createAction).toHaveBeenCalledTimes(1);
  });

  it('never renders forbidden status/Zendesk vocabulary (brief section 20)', () => {
    renderForm();
    const text = document.body.textContent ?? '';
    for (const banned of ['sent', 'ticket', 'zendesk', 'notified']) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });
});
