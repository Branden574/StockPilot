/**
 * The two settings cards on Reorder Planning (P4.C2 redesign): Planning
 * settings keeps its three fields, limits and Save; Automatic reordering keeps
 * the Pro notice, the enable box (now the shared checkbox, still saved only
 * with "Save settings"), the mode select and the cap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const setAuto = vi.fn(async (_p: unknown) => ({ ok: true as const, data: undefined }));
vi.mock('@/server/actions/auto-reorder-settings', () => ({
  setAutoReorderSettingsAction: (p: unknown) => setAuto(p),
}));

import { AutoReorderPanel } from './auto-reorder-panel';

beforeEach(() => vi.clearAllMocks());

describe('AutoReorderPanel', () => {
  it('shows the Pro notice and no controls when not entitled', () => {
    render(
      <AutoReorderPanel
        initial={{ enabled: false, mode: 'draft', maxAutoSendCents: null }}
        entitled={false}
      />,
    );
    expect(screen.getByText(/Upgrade to Pro or above to enable it/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('the enable box toggles locally and is saved only with Save settings', async () => {
    render(
      <AutoReorderPanel
        initial={{ enabled: false, mode: 'draft', maxAutoSendCents: null }}
        entitled
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Enable automatic reordering' });
    expect(box).not.toBeChecked();
    expect(screen.queryByLabelText('When stock is low')).toBeNull();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(setAuto).not.toHaveBeenCalled();

    const mode = screen.getByLabelText('When stock is low');
    fireEvent.change(mode, { target: { value: 'send' } });
    // Re-pinned by fix/recurring-po-auto-order-words-b64-b105 (B105,
    // 2026-11-02; was: "Auto-send cap ($, optional)"): the mode marks the
    // purchase order as ordered and sends nothing.
    fireEvent.change(screen.getByLabelText('Auto-order cap ($, optional)'), {
      target: { value: '250' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(setAuto).toHaveBeenCalledWith({
        enabled: true,
        mode: 'send',
        maxAutoSendCents: 25000,
      }),
    );
  });

  // B105: the mode said "Auto-send the PO to the supplier" and "Draft =
  // someone reviews + sends.", but the run only marks the purchase order as
  // ordered (runAutoReorder's updateStatus 'ordered'): nothing is sent to a
  // supplier, so the words say what happens. The rule the help states
  // (under a cap or the approval threshold, never with neither) is the
  // run's, shouldAutoSend, and stays as it was.
  it('names the mode for what it does, and says nothing is sent to the supplier', () => {
    render(
      <AutoReorderPanel
        initial={{ enabled: true, mode: 'send', maxAutoSendCents: null }}
        entitled
      />,
    );
    const mode = screen.getByLabelText('When stock is low');
    expect(
      Array.from((mode as HTMLSelectElement).options).map((o) => [o.value, o.textContent]),
    ).toEqual([
      ['draft', 'Create a draft PO for review'],
      ['send', 'Mark as ordered automatically'],
    ]);
    expect(mode).toHaveValue('send');
    expect(
      screen.getByText(/^Draft = someone reviews the PO and marks it as ordered\./),
    ).toHaveTextContent(
      "Draft = someone reviews the PO and marks it as ordered. Mark as ordered automatically still respects PO approval thresholds — and a PO is only marked as ordered when it's under a cap or your approval threshold; without either ceiling it's drafted for review instead. Nothing is sent to the supplier. Send them the purchase order yourself.",
    );
    expect(screen.getByLabelText('Auto-order cap ($, optional)')).toHaveValue(null);
    expect(
      screen.getByText('A PO above this is left as a draft instead of being marked as ordered.'),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/auto-?sen[dt]|\bsends\b/i);
  });
});
