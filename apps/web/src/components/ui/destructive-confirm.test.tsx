import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DestructiveConfirm } from './destructive-confirm';

function StandardHarness({
  onConfirm,
  pending = false,
}: {
  onConfirm?: () => void;
  pending?: boolean;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={setOpen}
      title="Archive item?"
      description="This sets the item's status to archived. Stock levels stay intact."
      confirmLabel="Archive"
      pending={pending}
      onConfirm={() => onConfirm?.()}
    />
  );
}

function CriticalHarness({
  onConfirm,
  expectedConfirm = 'delete-me',
}: {
  onConfirm?: () => void;
  expectedConfirm?: string;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={setOpen}
      severity="critical"
      title="Delete organization?"
      description="Every member loses access immediately."
      confirmLabel="Delete organization"
      expectedConfirm={expectedConfirm}
      onConfirm={() => onConfirm?.()}
    />
  );
}

describe('DestructiveConfirm — standard', () => {
  it('renders the title and description', () => {
    render(<StandardHarness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Archive item?')).toBeInTheDocument();
    expect(
      screen.getByText(/This sets the item's status to archived/i),
    ).toBeInTheDocument();
  });

  it('closes via the Cancel button (onOpenChange called with false)', async () => {
    const user = userEvent.setup();
    function Wrapper() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <span data-testid="state">{open ? 'open' : 'closed'}</span>
          <DestructiveConfirm
            open={open}
            onOpenChange={setOpen}
            title="Archive item?"
            description="…"
            confirmLabel="Archive"
            onConfirm={() => {}}
          />
        </>
      );
    }
    render(<Wrapper />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('state')).toHaveTextContent('closed');
  });

  it('confirm button calls onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<StandardHarness onConfirm={onConfirm} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons when pending=true', async () => {
    render(<StandardHarness pending />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // While pending, the confirm button replaces its label with a spinner.
    // Locate it by its disabled, destructive variant role instead of name.
    const buttons = within(dialog).getAllByRole('button');
    // Footer holds Cancel + Confirm; both must be disabled.
    const enabled = buttons.filter((b) => !(b as HTMLButtonElement).disabled);
    // The header close (X) button stays enabled — that's fine.
    expect(enabled.length).toBeLessThanOrEqual(1);
  });
});

describe('DestructiveConfirm — critical', () => {
  it('disables confirm until the expectedConfirm string is typed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CriticalHarness onConfirm={onConfirm} expectedConfirm="branden574" />);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /Delete organization/i });
    expect(confirm).toBeDisabled();

    // Wrong text → still disabled.
    const input = within(dialog).getByLabelText(/Type .* to confirm/i);
    await user.type(input, 'BRANDEN574'); // case-sensitive mismatch
    expect(confirm).toBeDisabled();

    // Click is a no-op while disabled.
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('enables confirm and fires onConfirm when matching string is typed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CriticalHarness onConfirm={onConfirm} expectedConfirm="delete-me" />);
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/Type .* to confirm/i);
    await user.type(input, 'delete-me');
    const confirm = within(dialog).getByRole('button', { name: /Delete organization/i });
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the "This cannot be undone." copy', () => {
    render(<CriticalHarness />);
    expect(screen.getByText(/This cannot be undone\./i)).toBeInTheDocument();
  });
});
