import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Switch } from './switch';

/**
 * The shared switch (redesign P2.2). Controlled by its caller; an optimistic
 * save flips the caller's value, marks the switch pending, and puts the old
 * value back when the save is refused. The switch must draw exactly what it is
 * given, ignore presses while a save is out, and keep the keyboard user's focus.
 */

/** The settings pattern: optimistic flip, one save at a time, revert on refusal. */
function OptimisticHarness({ save }: { save: (next: boolean) => Promise<void> }) {
  const [on, setOn] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <>
      <Switch
        checked={on}
        pending={pending}
        label="Toggle Rentals"
        onCheckedChange={async (next) => {
          const before = on;
          setOn(next);
          setPending(true);
          setError(null);
          try {
            await save(next);
          } catch {
            setOn(before);
            setError('Could not save. Nothing changed.');
          } finally {
            setPending(false);
          }
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

describe('Switch', () => {
  it('is a switch named by its label, on or off as its caller says', () => {
    const { rerender } = render(<Switch checked={false} label="Toggle weekly digest" />);
    const sw = screen.getByRole('switch', { name: 'Toggle weekly digest' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('type', 'button');
    rerender(<Switch checked label="Toggle weekly digest" />);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('asks for the other value and draws nothing on its own (controlled)', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} label="Toggle Books" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'Toggle Books' });
    await user.click(sw);
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    // The caller did not change `checked`, so neither does the switch.
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('optimistic save refused: flips at once, is busy while saving, then goes back and says so', async () => {
    const user = userEvent.setup();
    let refuse!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          refuse = () => reject(new Error('refused'));
        }),
    );
    render(<OptimisticHarness save={save} />);
    const sw = screen.getByRole('switch', { name: 'Toggle Rentals' });

    await user.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveBeenCalledTimes(1);

    // A second press while the save is out does nothing.
    await user.click(sw);
    expect(save).toHaveBeenCalledTimes(1);
    expect(sw).toHaveAttribute('aria-checked', 'true');

    refuse();
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    expect(sw).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save. Nothing changed.');
    // Pending never disabled it, so the keyboard user is still on it.
    expect(sw).toHaveFocus();
  });

  it('optimistic save accepted: stays on', async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {});
    render(<OptimisticHarness save={save} />);
    const sw = screen.getByRole('switch', { name: 'Toggle Rentals' });
    await user.click(sw);
    await waitFor(() => expect(sw).not.toHaveAttribute('aria-busy'));
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(save).toHaveBeenCalledWith(true);
  });

  it('Space and Enter each press it once', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked label="Toggle Orders" onCheckedChange={onCheckedChange} />);
    await user.tab();
    expect(screen.getByRole('switch', { name: 'Toggle Orders' })).toHaveFocus();
    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
    expect(onCheckedChange).toHaveBeenNthCalledWith(1, false);
  });

  it('disabled: no press', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} disabled label="Toggle Sports" onCheckedChange={onCheckedChange} />,
    );
    const sw = screen.getByRole('switch', { name: 'Toggle Sports' });
    expect(sw).toBeDisabled();
    await user.click(sw);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('keeps a visible track edge and thumb in forced colors, on and off', () => {
    // Forced colors (Windows High Contrast) remove backgrounds, which drew the
    // whole switch: it disappeared in both states. The track takes a
    // system-colour edge and the thumb a system-colour fill; the thumb's side
    // shows the state.
    const { rerender } = render(<Switch checked={false} label="Toggle Rentals" />);
    for (const checked of [false, true]) {
      rerender(<Switch checked={checked} label="Toggle Rentals" />);
      const sw = screen.getByRole('switch', { name: 'Toggle Rentals' });
      expect(sw).toHaveClass('forced-colors:border', 'forced-colors:border-[ButtonText]');
      expect(sw.firstElementChild).toHaveClass(
        'forced-colors:forced-color-adjust-none',
        'forced-colors:bg-[ButtonText]',
        checked ? 'translate-x-[18px]' : 'translate-x-0.5',
      );
    }
  });

  it('can be named by aria-labelledby and passes test hooks through', () => {
    render(
      <>
        <span id="lbl">Email me a weekly inventory digest</span>
        <Switch checked={false} aria-labelledby="lbl" data-testid="digest-switch" />
      </>,
    );
    expect(screen.getByTestId('digest-switch')).toHaveAccessibleName(
      'Email me a weekly inventory digest',
    );
  });
});
