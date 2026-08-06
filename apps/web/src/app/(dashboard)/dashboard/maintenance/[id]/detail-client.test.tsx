import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
}));

import { MaintenanceRequestActions } from './detail-client';

// Matches page.test.tsx's "StockPilot activity timeline honesty sweep" word
// list EXACTLY (fix wave Important 3). Task 14's lesson: Radix's Dialog
// unmounts DialogContent from the DOM entirely while `open` is false, so a
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
];

describe('MaintenanceRequestActions confirm-dialog vocabulary sweep (fix wave Important 3)', () => {
  it('the OPEN Cancel confirm dialog never contains forbidden ticket/notification vocabulary', async () => {
    render(<MaintenanceRequestActions requestId="r1" showArchive={false} showCancel={true} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    // Confirms the dialog actually opened before sweeping — an accidental
    // no-op click would otherwise make this test vacuously pass.
    expect(screen.getByText('Cancel this maintenance request?')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('the OPEN Archive confirm dialog never contains forbidden ticket/notification vocabulary', async () => {
    render(<MaintenanceRequestActions requestId="r1" showArchive={true} showCancel={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Archive this maintenance request?')).toBeInTheDocument();
    for (const banned of FORBIDDEN) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('a closed sweep before either dialog is opened would prove nothing — both buttons render but neither dialog is in the DOM yet', () => {
    render(<MaintenanceRequestActions requestId="r1" showArchive={true} showCancel={true} />);
    expect(screen.queryByText('Cancel this maintenance request?')).not.toBeInTheDocument();
    expect(screen.queryByText('Archive this maintenance request?')).not.toBeInTheDocument();
  });
});
