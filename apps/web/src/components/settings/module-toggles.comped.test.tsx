import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A comped organization can USE every module whatever these switches say. The
 * switches still matter (they decide what runs on its own: jobs, exports,
 * emails, public links), so they stay operable. What must not happen is the page
 * calling an included module "disabled", which is what it used to do.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const setModuleEnabledAction = vi.hoisted(() => vi.fn());
vi.mock('@/server/actions/module-settings', () => ({
  setModuleEnabledAction: (...a: unknown[]) => setModuleEnabledAction(...a),
}));

import { ModuleToggles } from './module-toggles';

const modules = [
  { id: 'inventory' as const, title: 'Inventory', tier: 'core' as const },
  { id: 'rentals' as const, title: 'Rentals', tier: 'optional' as const },
  { id: 'price_tracking' as const, title: 'Price monitoring', tier: 'optional' as const },
];

const rowFor = (title: string) =>
  screen.getByText(title).closest('div.flex.items-center.justify-between') as HTMLElement;

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  setModuleEnabledAction.mockReset();
});

describe('ModuleToggles for a comped organization', () => {
  it('marks a switched-off module as INCLUDED, because it is still usable', () => {
    render(<ModuleToggles modules={modules} enabledIds={['rentals']} comped />);
    expect(within(rowFor('Price monitoring')).getByText('Included')).toBeInTheDocument();
    // Switched on: nothing to explain. Core: "Always on" already says it.
    expect(within(rowFor('Rentals')).queryByText('Included')).toBeNull();
    expect(within(rowFor('Inventory')).queryByText('Included')).toBeNull();
  });

  it('shows no such marker to an organization that is not comped: off means off there', () => {
    render(<ModuleToggles modules={modules} enabledIds={['rentals']} />);
    expect(screen.queryByText('Included')).toBeNull();
  });

  it('keeps the switch operable: it is the off switch for jobs, exports and public links', () => {
    render(<ModuleToggles modules={modules} enabledIds={['rentals']} comped />);
    expect(screen.getByRole('switch', { name: 'Toggle Rentals' })).not.toBeDisabled();
  });

  it('does not claim the module was DISABLED when a comped organization switches it off', async () => {
    setModuleEnabledAction.mockResolvedValue({ ok: true, data: { enabled: [] } });
    render(<ModuleToggles modules={modules} enabledIds={['rentals']} comped />);
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Rentals' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const said = String(toast.success.mock.calls[0]![0]);
    expect(said).toMatch(/stays available/i);
    expect(said).not.toMatch(/disabled/i);
  });

  it('the cascade dialog does not call included modules DISABLED either', () => {
    const withDependents = [
      { id: 'orders' as const, title: 'Orders', tier: 'optional' as const },
      { id: 'public_requests' as const, title: 'Public requests', tier: 'optional' as const },
    ];
    render(
      <ModuleToggles modules={withDependents} enabledIds={['orders', 'public_requests']} comped />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Orders' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Switch off Orders?');
    expect(dialog.textContent).not.toMatch(/disable/i);
    expect(dialog).toHaveTextContent(/stay available to your team/i);
  });

  it('the same dialog still says DISABLE to an organization that is not comped', () => {
    const withDependents = [
      { id: 'orders' as const, title: 'Orders', tier: 'optional' as const },
      { id: 'public_requests' as const, title: 'Public requests', tier: 'optional' as const },
    ];
    render(<ModuleToggles modules={withDependents} enabledIds={['orders', 'public_requests']} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Orders' }));
    expect(within(screen.getByRole('dialog')).getByRole('heading')).toHaveTextContent(
      'Disable Orders?',
    );
  });

  it('still says "disabled" to an organization that is not comped, where it is true', async () => {
    setModuleEnabledAction.mockResolvedValue({ ok: true, data: { enabled: [] } });
    render(<ModuleToggles modules={modules} enabledIds={['rentals']} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Rentals' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(String(toast.success.mock.calls[0]![0])).toBe('Rentals disabled.');
  });
});
