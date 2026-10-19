import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Billing tab's override and trial forms (matrix W-AD-13d), restyled in
 * P5.3. Pinned: every field is now named by its label (they were not tied to
 * their inputs), the "Unlock every premium module" box is the shared checkbox
 * and still saves what it shows, the custom price fields appear only for a
 * custom price, Start trial keeps its exact native confirm, and both saves
 * retry once after a fresh MFA step-up.
 */

const h = vi.hoisted(() => ({
  save: vi.fn(),
  trial: vi.fn(),
  ensure: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: h.ensure, modal: null }),
}));
vi.mock('@/server/actions/platform/billing', () => ({
  setOrgBillingAction: (...a: unknown[]) => h.save(...a),
  startOrgTrialAction: (...a: unknown[]) => h.trial(...a),
}));

import { BillingPanel, type BillingPanelProps } from './billing-panel';

const ORG = 'org-1';

function renderPanel(over: Partial<BillingPanelProps> = {}) {
  return render(
    <BillingPanel
      organizationId={ORG}
      accessTier={null}
      arrangement="standard"
      customPriceCents={null}
      customPriceInterval={null}
      allModulesComp={false}
      billingNotes={null}
      trialTier={null}
      trialEndsAt={null}
      hasStripeSubscription={false}
      effectiveLabel="Pro"
      trialDaysRemaining={null}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue({ ok: true, data: {} });
  h.trial.mockResolvedValue({ ok: true, data: {} });
  h.ensure.mockResolvedValue(true);
});

describe('BillingPanel', () => {
  it('names every field by its label', () => {
    renderPanel({ arrangement: 'custom' });
    for (const label of [
      'Access tier',
      'Billing arrangement',
      'Custom price (USD)',
      'Interval',
      'Notes',
      'Days',
      'Trial unlocks',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('shows the custom price fields only for a custom price', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.queryByLabelText('Custom price (USD)')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Billing arrangement'), 'custom');
    expect(screen.getByLabelText('Custom price (USD)')).toBeInTheDocument();
  });

  it('saves what the form shows, the premium-module box included', async () => {
    const user = userEvent.setup();
    renderPanel();
    const box = screen.getByRole('checkbox', {
      name: 'Unlock every premium module (full feature access)',
    });
    expect(box).toHaveAttribute('aria-checked', 'false');
    await user.click(box);
    expect(box).toHaveAttribute('aria-checked', 'true');
    await user.selectOptions(screen.getByLabelText('Access tier'), 'enterprise');
    await user.selectOptions(screen.getByLabelText('Billing arrangement'), 'comped');
    await user.type(screen.getByLabelText('Notes'), ' pilot ');
    await user.click(screen.getByRole('button', { name: 'Save billing' }));
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith({
        organizationId: ORG,
        accessTier: 'enterprise',
        arrangement: 'comped',
        customPriceCents: null,
        customPriceInterval: null,
        allModulesComp: true,
        billingNotes: 'pilot',
      }),
    );
    expect(h.success).toHaveBeenCalledWith('Billing updated.');
  });

  it('retries a save once after a fresh step-up', async () => {
    const user = userEvent.setup();
    h.save
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'x', details: { reason: 'aal2_required' } },
      })
      .mockResolvedValueOnce({ ok: true, data: {} });
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Save billing' }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith('Billing updated.');
  });

  it('starts a trial only after the exact native confirm', async () => {
    const user = userEvent.setup();
    // jsdom has no window.confirm to spy on, so stub it (as user-actions-menu.test.tsx does).
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Start trial' }));
    expect(confirm).toHaveBeenLastCalledWith('Start a 14-day enterprise trial for this org?');
    expect(h.trial).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Start trial' }));
    await waitFor(() =>
      expect(h.trial).toHaveBeenCalledWith({
        organizationId: ORG,
        days: 14,
        trialTier: 'enterprise',
      }),
    );
    expect(h.success).toHaveBeenCalledWith('14-day trial started.');
    vi.unstubAllGlobals();
  });

  it('keeps the effective line', () => {
    renderPanel({
      trialDaysRemaining: 5,
      hasStripeSubscription: true,
      effectiveLabel: 'Business · trial',
    });
    expect(screen.getByText(/Effective right now:/).textContent).toBe(
      'Effective right now: Business · trial · 5d trial left · has a live Stripe subscription',
    );
  });
});
