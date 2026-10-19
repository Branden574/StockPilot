// Portal pricing on the shared RadioGroup (P4.F2, row W-WS-10): two native
// radios under the old name, each named by its label with its helper as the
// description, and Save enabled only when the choice changed.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/server/actions/customers', () => ({ setPortalPricingModeAction: h.save }));

import { PortalPricingModePanel } from './portal-pricing-mode-panel';

beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ ok: true, data: null });
});

describe('PortalPricingModePanel', () => {
  it('shows the two choices as radios, the saved one checked, Save off until the choice changes', async () => {
    const user = userEvent.setup();
    render(<PortalPricingModePanel initial="no_charge" />);
    expect(screen.getByRole('heading', { name: 'Portal pricing' })).toBeInTheDocument();
    const none = screen.getByRole('radio', {
      name: 'This organisation does not charge its customers',
    });
    const priced = screen.getByRole('radio', { name: 'Customers are charged from a price list' });
    expect(none).toBeChecked();
    expect(none).toHaveAttribute('name', 'portal-pricing-mode');
    expect(priced).toHaveAccessibleDescription(
      "Each account's price list sets what it pays. Items with no price show a request-quote option.",
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.click(priced);
    expect(priced).toBeChecked();
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(h.save).toHaveBeenCalledWith('priced'));
  });

  it('turns Save back off when the saved choice is picked again', async () => {
    const user = userEvent.setup();
    render(<PortalPricingModePanel initial="priced" />);
    await user.click(
      screen.getByRole('radio', { name: 'This organisation does not charge its customers' }),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(
      screen.getByRole('radio', { name: 'Customers are charged from a price list' }),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
