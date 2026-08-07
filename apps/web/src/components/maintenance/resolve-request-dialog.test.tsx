import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

type ActionResult = { ok: true } | { error: { message: string } };
const resolveAction = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  resolveMaintenanceRequestAction: (...args: unknown[]) => resolveAction(...args),
}));

// The real MaintenancePhotosPanel does mint/PUT/finalize network calls this
// suite has no business exercising (that's maintenance-photos-panel.test.tsx's
// job) — mocked here purely to PIN the `kind` prop the dialog threads through
// (brief Step 1 test 5), matching this repo's "prop pin via mock" idiom.
const photosPanelProps = vi.fn();
vi.mock('@/components/maintenance/maintenance-photos-panel', () => ({
  MaintenancePhotosPanel: (props: Record<string, unknown>) => {
    photosPanelProps(props);
    return <div data-testid="photos-panel-stub" />;
  },
}));

import { ResolveRequestDialog } from './resolve-request-dialog';

function noopFetch(): Promise<Response> {
  return Promise.resolve({ ok: false } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAction.mockClear();
  resolveAction.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', vi.fn(noopFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof ResolveRequestDialog>> = {}) {
  const onOpenChange = vi.fn();
  const onResolved = vi.fn();
  const utils = render(
    <ResolveRequestDialog
      requestId="r1"
      requesterName="Jane Smith"
      open={true}
      onOpenChange={onOpenChange}
      onResolved={onResolved}
      {...overrides}
    />,
  );
  return { ...utils, onOpenChange, onResolved };
}

describe('ResolveRequestDialog — note requirement (Step 1 test 1)', () => {
  it('the confirm button is disabled until the note is non-empty, and typing enables it', async () => {
    renderDialog();
    const confirm = screen.getByRole('button', { name: 'Mark resolved' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Resolution note'), 'Replaced the leaking roof tile.');
    expect(confirm).toBeEnabled();
  });

  it('a note under the schema minimum (post-trim) leaves confirm disabled', async () => {
    renderDialog();
    await userEvent.type(screen.getByLabelText('Resolution note'), 'Hi');
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeDisabled();
  });
});

describe('ResolveRequestDialog — confirm action (Step 1 test 2)', () => {
  it('calls resolveMaintenanceRequestAction(requestId, { note }) — argument object pinned — and fires onResolved + a success toast', async () => {
    const { onResolved, onOpenChange } = renderDialog();
    await userEvent.type(screen.getByLabelText('Resolution note'), 'Replaced the leaking roof tile.');
    await userEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    await waitFor(() =>
      expect(resolveAction).toHaveBeenCalledWith('r1', { note: 'Replaced the leaking roof tile.' }),
    );
    expect(onResolved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('ResolveRequestDialog — server error handling (Step 1 test 3)', () => {
  it('a ServiceError result toasts the server message, keeps the dialog open, and never fires onResolved', async () => {
    resolveAction.mockResolvedValueOnce({ error: { message: 'This request is already resolved.' } });
    const { onResolved, onOpenChange } = renderDialog();
    await userEvent.type(screen.getByLabelText('Resolution note'), 'Replaced the leaking roof tile.');
    await userEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('This request is already resolved.'));
    expect(onResolved).not.toHaveBeenCalled();
    // onOpenChange(false) is how the CALLER would close it; a failed
    // resolve must never invoke that — the dialog stays open, note and any
    // staged proof photos intact.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
  });
});

describe('ResolveRequestDialog — copy pins + §GC-4 forbidden-vocabulary sweep (Step 1 test 4)', () => {
  // Extends the archive/cancel FORBIDDEN list (detail-client.test.tsx) with
  // the spec §11 additions for the resolved state.
  const FORBIDDEN = [
    'Ticket created',
    'Request submitted to Zendesk',
    'DC4 notified',
    'Andrew notified',
    'Ticket assigned',
    'Email sent',
    'Zendesk comment',
    'Ticket closed',
    'Ticket resolved',
    'Zendesk ticket closed',
    'Zendesk ticket updated',
    'Zendesk ticket resolved',
    'Issue verified fixed',
  ];

  it('the honesty disclosure and the proof-photo caption render verbatim, in the CLOSED (unmounted) state proving nothing, then OPEN', () => {
    const { rerender } = render(
      <ResolveRequestDialog
        requestId="r1"
        requesterName="Jane Smith"
        open={false}
        onOpenChange={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    // Radix unmounts DialogContent while closed (Task 14's lesson) — a
    // sweep here would prove nothing, which is exactly why this dialog
    // is rendered open below before any assertion runs.
    expect(document.body.textContent).not.toContain('Resolve this maintenance request?');

    rerender(
      <ResolveRequestDialog
        requestId="r1"
        requesterName="Jane Smith"
        open={true}
        onOpenChange={vi.fn()}
        onResolved={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain('It does not close or update the Zendesk ticket.');
    expect(document.body.textContent).toContain(
      'Proof photos upload immediately and stay attached to this request even if you close this dialog without confirming.',
    );
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('the forbidden sweep also holds across submitting and error states', async () => {
    resolveAction.mockImplementationOnce(
      () =>
        new Promise<ActionResult>((resolve) => {
          setTimeout(() => resolve({ ok: true }), 0);
        }),
    );
    renderDialog();
    await userEvent.type(screen.getByLabelText('Resolution note'), 'Replaced the leaking roof tile.');
    const confirmClick = userEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));
    // Submitting state (pending=true, both buttons disabled) — sweep here too.
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
    await confirmClick;
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());

    // `sonner` is mocked (no real Toaster mounts, so nothing it's called
    // with ever reaches document.body) — the success toast's OWN message
    // is swept directly against the mock's recorded call arguments so a
    // forbidden phrase planted there (T7-M4) cannot hide behind the mock.
    const successCallText = toastSuccessMock.mock.calls.flat().join(' ');
    for (const banned of FORBIDDEN) {
      expect(successCallText).not.toContain(banned);
    }

    // Error state.
    resolveAction.mockResolvedValueOnce({ error: { message: 'This request is already resolved.' } });
    await userEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });
});

describe('ResolveRequestDialog — embedded photos panel (Step 1 test 5)', () => {
  it('passes kind="resolution" to MaintenancePhotosPanel — prop pin via mock', () => {
    renderDialog();
    expect(screen.getByTestId('photos-panel-stub')).toBeInTheDocument();
    expect(photosPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'r1', kind: 'resolution' }),
    );
  });
});
