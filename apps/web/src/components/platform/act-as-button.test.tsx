import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Act as this org" (matrix W-AD-13a, P5.3). Pinned: it is drawn as the
 * secondary (outline) button, since it enters a mode rather than committing
 * the work in front of you, so the Billing tab's Save billing stays the page's
 * only ink primary (P5.3 review). Its words, the exact native confirm, the
 * in-place step-up retry with the identical payload and the way into the
 * dashboard are unchanged.
 */

const h = vi.hoisted(() => ({
  start: vi.fn(),
  ensure: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock('@/components/auth/step-up-modal', () => ({
  useStepUp: () => ({ ensure: h.ensure, modal: null }),
}));
vi.mock('@/server/actions/platform/impersonation', () => ({
  startActingAsAction: (...a: unknown[]) => h.start(...a),
}));

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { ActAsButton } from './act-as-button';

const ORG = 'org-1';

/**
 * The classes a shared Button variant draws, read from the primitive's own
 * export, so this pin follows a restyle of the primitive instead of naming
 * its internal classes.
 */
function look(variant: 'default' | 'outline'): string[] {
  return cn(buttonVariants({ variant })).split(/\s+/).filter(Boolean);
}
const CONFIRM =
  "Act as “Acme”? You'll be able to view AND edit their live data. Every action is logged, and the grant auto-expires in 45 minutes.";

beforeEach(() => {
  vi.clearAllMocks();
  h.start.mockResolvedValue({ ok: true, data: {} });
  h.ensure.mockResolvedValue(true);
  // jsdom has no window.confirm to spy on, so stub it (as billing-panel.test.tsx does).
  h.confirm.mockReturnValue(true);
  vi.stubGlobal('confirm', h.confirm);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function button() {
  return screen.getByRole('button', { name: 'Act as this org' });
}

describe('ActAsButton', () => {
  it('is the secondary (outline) button, never the ink primary, and keeps 44 px on a phone', () => {
    render(<ActAsButton organizationId={ORG} orgName="Acme" />);
    const outline = look('outline');
    const inkOnly = look('default').filter((c) => !outline.includes(c));
    // The ink primary draws classes the outline one does not (its fill).
    expect(inkOnly.length).toBeGreaterThan(0);
    expect(button()).toHaveClass(...outline, 'max-sm:h-11');
    for (const c of inkOnly) expect(button()).not.toHaveClass(c);
    expect(button()).toHaveAttribute('type', 'button');
  });

  it('asks the exact confirm first and does nothing when it is declined', async () => {
    h.confirm.mockReturnValue(false);
    render(<ActAsButton organizationId={ORG} orgName="Acme" />);
    await userEvent.click(button());
    expect(h.confirm).toHaveBeenCalledWith(CONFIRM);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('enters the org and goes to the dashboard', async () => {
    render(<ActAsButton organizationId={ORG} orgName="Acme" />);
    await userEvent.click(button());
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/dashboard'));
    expect(h.start).toHaveBeenCalledWith({ organizationId: ORG });
    expect(h.success).toHaveBeenCalledWith('Now acting as Acme.');
    expect(h.refresh).toHaveBeenCalled();
  });

  it('retries once with the identical payload after a fresh MFA step-up', async () => {
    h.start
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Step-up needed', details: { reason: 'aal2_required' } },
      })
      .mockResolvedValueOnce({ ok: true, data: {} });
    render(<ActAsButton organizationId={ORG} orgName="Acme" />);
    await userEvent.click(button());
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/dashboard'));
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.start.mock.calls[1]).toEqual(h.start.mock.calls[0]);
  });

  it('stops without a second call when the step-up is cancelled', async () => {
    h.start.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Step-up needed', details: { reason: 'aal2_required' } },
    });
    h.ensure.mockResolvedValueOnce(false);
    render(<ActAsButton organizationId={ORG} orgName="Acme" />);
    await userEvent.click(button());
    await waitFor(() => expect(h.ensure).toHaveBeenCalledTimes(1));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it('shows a refusal as an error toast and stays put', async () => {
    h.start.mockResolvedValueOnce({ ok: false, error: { message: 'Not allowed' } });
    render(<ActAsButton organizationId={ORG} orgName="Acme" />);
    await userEvent.click(button());
    await waitFor(() => expect(h.error).toHaveBeenCalledWith('Not allowed'));
    expect(h.push).not.toHaveBeenCalled();
  });
});
