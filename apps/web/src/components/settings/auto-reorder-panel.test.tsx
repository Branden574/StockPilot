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
    fireEvent.change(screen.getByLabelText('Auto-send cap ($, optional)'), {
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
});
