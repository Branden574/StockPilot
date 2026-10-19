import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_PREF_KEYS, type NotificationPreferences } from '@/lib/notification-prefs';

/**
 * Each notification switch is busy for its own save. Before, one shared
 * "saving key" meant that when the first of two quick saves came back, the
 * second switch was released while its own save was still out.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const pending = vi.hoisted(() => [] as Array<(r: unknown) => void>);
const update = vi.hoisted(() =>
  vi.fn(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  ),
);
vi.mock('@/server/actions/notification-preferences', () => ({
  updateNotificationPreferencesAction: update,
}));

import { NotificationPreferencesForm } from './notification-preferences-form';

function allOn(): NotificationPreferences {
  return Object.fromEntries(
    NOTIFICATION_PREF_KEYS.map((k) => [k, true]),
  ) as NotificationPreferences;
}

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
});

describe('NotificationPreferencesForm saves', () => {
  it('keeps the second switch busy until its own save returns', async () => {
    render(<NotificationPreferencesForm initial={allOn()} />);
    const a = screen.getByRole('switch', { name: 'Toggle Order received' });
    const b = screen.getByRole('switch', { name: 'Toggle Stock transfers' });
    fireEvent.click(a);
    fireEvent.click(b);
    expect(update).toHaveBeenCalledTimes(2);
    expect(a).toHaveAttribute('aria-busy', 'true');
    expect(b).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      pending[0]!({ ok: true });
    });
    expect(a).not.toHaveAttribute('aria-busy');
    expect(b).toHaveAttribute('aria-busy', 'true');
    // A busy switch ignores presses: no third save.
    fireEvent.click(b);
    expect(update).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[1]!({ ok: true });
    });
    expect(b).not.toHaveAttribute('aria-busy');
    expect(b).toHaveAttribute('aria-checked', 'false');
  });

  it('puts a refused switch back', async () => {
    render(<NotificationPreferencesForm initial={allOn()} />);
    const a = screen.getByRole('switch', { name: 'Toggle Order received' });
    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-checked', 'false');
    await act(async () => {
      pending[0]!({ ok: false, error: { message: 'No.' } });
    });
    expect(a).toHaveAttribute('aria-checked', 'true');
  });
});
