import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

type ActionResult = { ok: true } | { error: { message: string } };
const archive = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
const cancel = vi.fn(async (..._args: unknown[]): Promise<ActionResult> => ({ ok: true }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  archiveMaintenanceRequestAction: (...args: unknown[]) => archive(...args),
  cancelMaintenanceRequestAction: (...args: unknown[]) => cancel(...args),
  resolveMaintenanceRequestAction: vi.fn(async () => ({ ok: true }) as ActionResult),
}));

import { MaintenanceRequestActions } from './detail-client';

// ResolveRequestDialog no longer does its own network fetch (fix wave
// Important 2 — resolutionPhotos is prop-threaded from the page instead of
// a client GET on open); this stub stays only as a tripwire so this suite
// never silently starts depending on a real network call again. None of
// these tests assert on it.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
});
afterEach(() => vi.unstubAllGlobals());

// Matches page.test.tsx's "StockPilot activity timeline honesty sweep" word
// list EXACTLY (fix wave Important 3), extended by spec §11's new resolved-
// state forbidden phrases. Task 14's lesson: Radix's Dialog unmounts
// DialogContent from the DOM entirely while `open` is false, so a
// document.body sweep that never opens the dialog first cannot see its
// copy — that is precisely why mutation 9 (injecting "Ticket assigned to
// DC4" into the Cancel dialog's own description) survived all 304 of Task
// 15's original tests. The tests below OPEN each dialog before sweeping.
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

const BASE_PROPS = { requestId: 'r1', requesterName: 'Jane Smith', resolutionPhotos: [] };

describe('MaintenanceRequestActions confirm-dialog vocabulary sweep (fix wave Important 3)', () => {
  it('the OPEN Cancel confirm dialog never contains forbidden ticket/notification vocabulary', async () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={false} showCancel={true} showResolve={false} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    // Confirms the dialog actually opened before sweeping — an accidental
    // no-op click would otherwise make this test vacuously pass.
    expect(screen.getByText('Cancel this maintenance request?')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('the OPEN Archive confirm dialog never contains forbidden ticket/notification vocabulary', async () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={true} showCancel={false} showResolve={false} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Archive this maintenance request?')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('the OPEN Resolve dialog never contains forbidden ticket/notification vocabulary', async () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={false} showCancel={false} showResolve={true} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(screen.getByText('Resolve this maintenance request?')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('a closed sweep before any dialog is opened would prove nothing — all three buttons render but no dialog is in the DOM yet', () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={true} showCancel={true} showResolve={true} />,
    );
    expect(screen.queryByText('Cancel this maintenance request?')).not.toBeInTheDocument();
    expect(screen.queryByText('Archive this maintenance request?')).not.toBeInTheDocument();
    expect(screen.queryByText('Resolve this maintenance request?')).not.toBeInTheDocument();
  });
});

describe('MaintenanceRequestActions — Resolve affordance (Task 7 Step 1 test 6)', () => {
  it('showResolve renders the Resolve button and clicking it opens the dialog', async () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={false} showCancel={false} showResolve={true} />,
    );
    const resolveButton = screen.getByRole('button', { name: 'Resolve' });
    expect(resolveButton).toBeInTheDocument();
    await userEvent.click(resolveButton);
    expect(screen.getByText('Resolve this maintenance request?')).toBeInTheDocument();
  });

  it('showResolve=false never renders a Resolve button', () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={true} showCancel={true} showResolve={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});

describe('MaintenanceRequestActions — resolutionPhotos prop-threaded into the Resolve dialog (fix wave Important 2)', () => {
  it('a resolutionPhotos entry passed to MaintenanceRequestActions renders inside the OPEN Resolve dialog, through the real (unmocked) photos panel', async () => {
    render(
      <MaintenanceRequestActions
        {...BASE_PROPS}
        showArchive={false}
        showCancel={false}
        showResolve={true}
        resolutionPhotos={[
          { id: 'proof-1', originalFilename: 'after.jpg', url: 'https://signed/after.jpg', thumbUrl: null },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(screen.getByText('Resolve this maintenance request?')).toBeInTheDocument();
    // MUTATION GUARD (b): dropping the prop thread (or the dialog rendering
    // an empty list regardless of what it was given) leaves this absent.
    expect(screen.getByAltText('after.jpg')).toBeInTheDocument();
  });

  it('an empty resolutionPhotos array renders the dialog with no staged photos', async () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={false} showCancel={false} showResolve={true} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(screen.getByText('Resolve this maintenance request?')).toBeInTheDocument();
    expect(screen.getByText('Photos (0/8)')).toBeInTheDocument();
  });
});

describe('MaintenanceRequestActions — Archive confirm copy (Task 7 Step 1 test 7)', () => {
  it('pins the updated D1 re-bucket sentence and confirms the STALE sentence is gone', async () => {
    render(
      <MaintenanceRequestActions {...BASE_PROPS} showArchive={true} showCancel={false} showResolve={false} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(
      screen.getByText(
        'The request is marked archived and can no longer be edited. Use this to tidy up old resolved or cancelled requests, or duplicates.',
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('requests that are already resolved');
  });
});
