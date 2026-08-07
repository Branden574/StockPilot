import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAINTENANCE_RESOLUTION_NOTE_MAX } from '@stockpilot/core';

// The dialog now calls router.refresh() itself (fix wave Important 2 — it
// threads the embedded photos panel's onChange straight to it, matching the
// requester panel's own MaintenancePhotosPanelClient convention), so
// useRouter must resolve to something real. A single vi.hoisted object
// (not a fresh literal per render) keeps `refreshMock` a stable reference
// tests can assert against.
const routerMocks = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
}));

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

// Fix wave (Important 2): the dialog no longer does its own network fetch —
// this global stub stays only as a tripwire. Any test that asserts
// `fetch` was never called catches a regression back to the deleted
// loadResolutionPhotos() path; nothing in this suite expects fetch to
// succeed or even run.
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
      resolutionPhotos={[]}
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
        resolutionPhotos={[]}
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
        resolutionPhotos={[]}
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

describe('ResolveRequestDialog — resolutionPhotos prop-threaded, no fetch (fix wave Important 2)', () => {
  const PHOTOS = [
    { id: 'proof-1', originalFilename: 'after.jpg', url: 'https://signed/after.jpg', thumbUrl: null },
    { id: 'proof-2', originalFilename: 'before.jpg', url: 'https://signed/before.jpg', thumbUrl: 'https://signed/before-thumb.jpg' },
  ];

  it('renders the passed-in resolutionPhotos via MaintenancePhotosPanel — coverage the old fetch-on-open path never had', () => {
    renderDialog({ resolutionPhotos: PHOTOS });
    expect(screen.getByTestId('photos-panel-stub')).toBeInTheDocument();
    // MUTATION GUARD (b): dropping the prop thread (or always rendering [])
    // fails this — the mock records exactly what the dialog passed down.
    expect(photosPanelProps).toHaveBeenCalledWith(expect.objectContaining({ photos: PHOTOS, kind: 'resolution' }));
  });

  it('never calls fetch — loadResolutionPhotos and its GET /api/v1/maintenance-requests/[id] are gone', async () => {
    renderDialog({ resolutionPhotos: PHOTOS });
    // Give any stray microtask/effect a chance to run before asserting a
    // negative — same idiom as this file's other "never fired" checks.
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("threads the embedded panel's onChange straight to router.refresh() — the SAME post-upload freshness mechanism the requester photos panel already relies on", () => {
    renderDialog({ resolutionPhotos: PHOTOS });
    const lastCallProps = photosPanelProps.mock.calls.at(-1)?.[0] as { onChange?: () => void } | undefined;
    expect(typeof lastCallProps?.onChange).toBe('function');
    lastCallProps?.onChange?.();
    expect(routerMocks.refresh).toHaveBeenCalled();
  });
});

describe('ResolveRequestDialog — resolution note maxLength cap (fix wave Minor 4)', () => {
  it('the textarea maxLength attribute equals the shared MAINTENANCE_RESOLUTION_NOTE_MAX constant', () => {
    renderDialog();
    const textarea = screen.getByLabelText('Resolution note');
    expect(textarea).toHaveAttribute('maxLength', String(MAINTENANCE_RESOLUTION_NOTE_MAX));
  });

  it('literal-pins the constant itself at 2000 (anti-tautology: catches a silent drift in the shared cap, not just a copy of it)', () => {
    expect(MAINTENANCE_RESOLUTION_NOTE_MAX).toBe(2000);
    renderDialog();
    expect(screen.getByLabelText('Resolution note')).toHaveAttribute('maxLength', '2000');
  });
});
