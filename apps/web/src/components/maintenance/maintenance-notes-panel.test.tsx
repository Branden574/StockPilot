import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock, back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const addNote = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, id: 'note-1' }));
vi.mock('@/server/actions/maintenance-requests', () => ({
  addMaintenanceNoteAction: (...args: unknown[]) => addNote(...args),
}));

import { MaintenanceNotesPanel, type MaintenanceNoteRow } from './maintenance-notes-panel';

const NOTES: MaintenanceNoteRow[] = [
  { id: 'n1', authorUserId: 'u-1', body: 'Ordered a replacement filter.', createdAt: '2026-08-01T12:00:00Z' },
];

// Brief section 20's forbidden vocabulary + the specific phrase named in
// this panel's own step-1 spec ("never contains 'Zendesk comment'").
const FORBIDDEN = [
  'Zendesk comment',
  'Ticket created',
  'Request submitted to Zendesk',
  'DC4 notified',
  'Andrew notified',
  'Ticket assigned',
  'Email sent',
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MaintenanceNotesPanel', () => {
  it('renders nothing when canManage is false (requester must never see notes, not even an empty shell)', () => {
    const { container } = render(
      <MaintenanceNotesPanel
        requestId="r1"
        canManage={false}
        notes={NOTES}
        authorNames={{}}
        truncated={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Ordered a replacement filter.')).not.toBeInTheDocument();
  });

  it('with canManage: lists existing notes and submits a new one via addMaintenanceNoteAction', async () => {
    const user = userEvent.setup();
    render(
      <MaintenanceNotesPanel
        requestId="r1"
        canManage
        notes={NOTES}
        authorNames={{ 'u-1': 'Jane Smith' }}
        truncated={false}
      />,
    );

    // Existing note renders with its resolved author name.
    expect(screen.getByText('Ordered a replacement filter.')).toBeInTheDocument();
    expect(screen.getByText(/Jane Smith/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('New internal note'), 'Called the vendor for an ETA.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(addNote).toHaveBeenCalledWith('r1', 'Called the vendor for an ETA.');
    expect(refreshMock).toHaveBeenCalled();
  });

  it("labels notes 'Internal StockPilot notes' and never contains 'Zendesk comment' or any forbidden phrase", () => {
    render(
      <MaintenanceNotesPanel
        requestId="r1"
        canManage
        notes={NOTES}
        authorNames={{}}
        truncated={false}
      />,
    );
    expect(screen.getByText('Internal StockPilot notes')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('discloses truncation instead of implying the list is complete', () => {
    render(
      <MaintenanceNotesPanel requestId="r1" canManage notes={NOTES} authorNames={{}} truncated />,
    );
    expect(screen.getByText(/Showing the most recent 500 notes/)).toBeInTheDocument();
  });

  it('falls back to a generic author label when the note author is not in authorNames', () => {
    render(
      <MaintenanceNotesPanel requestId="r1" canManage notes={NOTES} authorNames={{}} truncated={false} />,
    );
    expect(screen.getByText(/^StockPilot coordinator ·/)).toBeInTheDocument();
  });
});
