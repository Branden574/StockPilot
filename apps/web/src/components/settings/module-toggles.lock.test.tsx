import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Module switches stay locked while a save is out (W-ST-08): no second toggle
 * can race the first. On the shared Switch the one being saved keeps focus
 * (busy, presses ignored) and every other switch is disabled, as before.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const pending = vi.hoisted(() => [] as Array<(r: unknown) => void>);
const setModule = vi.hoisted(() =>
  vi.fn(
    (_input: { moduleId: string; enabled: boolean }) =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  ),
);
vi.mock('@/server/actions/module-settings', () => ({ setModuleEnabledAction: setModule }));

import { ModuleToggles } from './module-toggles';

const modules = [
  { id: 'inventory' as const, title: 'Inventory', tier: 'core' as const },
  { id: 'rentals' as const, title: 'Rentals', tier: 'optional' as const },
  { id: 'price_tracking' as const, title: 'Price monitoring', tier: 'optional' as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

describe('ModuleToggles lock while saving', () => {
  it('locks every switch while one saves, keeping the saving one focusable', async () => {
    render(<ModuleToggles modules={modules} enabledIds={['rentals']} />);
    const rentals = screen.getByRole('switch', { name: 'Toggle Rentals' });
    const price = screen.getByRole('switch', { name: 'Toggle Price monitoring' });
    expect(screen.getByText('Always on')).toBeInTheDocument();

    rentals.focus();
    fireEvent.click(rentals);
    expect(setModule).toHaveBeenCalledWith({ moduleId: 'rentals', enabled: false });
    expect(rentals).toHaveAttribute('aria-busy', 'true');
    expect(rentals).not.toBeDisabled();
    expect(document.activeElement).toBe(rentals);
    expect(price).toBeDisabled();

    fireEvent.click(rentals);
    fireEvent.click(price);
    expect(setModule).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]!({ ok: true, data: { enabled: [] } });
    });
    expect(price).not.toBeDisabled();
    expect(rentals).not.toHaveAttribute('aria-busy');
    expect(rentals).toHaveAttribute('aria-checked', 'false');
  });
});
