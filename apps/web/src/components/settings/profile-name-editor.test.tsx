import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * A save button used to swap its words for a bare spinner while it worked,
 * which left an unnamed button (and a narrower one) on screen. It now keeps
 * its words beside the spinner.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const resolveSave = vi.hoisted(() => ({ current: null as null | ((r: unknown) => void) }));
vi.mock('@/server/actions/profile', () => ({
  updateProfileNameAction: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveSave.current = resolve;
      }),
  ),
}));

import { ProfileNameEditor } from './profile-name-editor';

describe('ProfileNameEditor', () => {
  it('keeps the button named "Save name" while the save is out', async () => {
    render(<ProfileNameEditor current="Ada" />);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Ada L' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    const pending = screen.getByRole('button', { name: 'Save name' });
    expect(pending).toBeDisabled();
    await act(async () => {
      resolveSave.current?.({ ok: true, data: null });
    });
  });
});
