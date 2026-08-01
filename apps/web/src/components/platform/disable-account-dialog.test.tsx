import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DisableAccountDialog } from './disable-account-dialog';

import type { DisableReasonInput } from '@stockpilot/core';

const EMAIL = 'target@example.com';

function Harness({
  email = EMAIL,
  pending = false,
  onConfirm,
  onOpenChange,
}: {
  email?: string;
  pending?: boolean;
  onConfirm?: (reason: DisableReasonInput) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <DisableAccountDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        setOpen(next);
      }}
      email={email}
      pending={pending}
      onConfirm={(reason) => onConfirm?.(reason)}
    />
  );
}

function confirmButton() {
  return screen.getByRole('button', { name: /disable account|disabling/i });
}

describe('DisableAccountDialog — the type-to-confirm gate', () => {
  it('states the cross-org blast radius and names the target', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText(/across every organization, not just this one/i),
    ).toBeInTheDocument();
    // The email must appear in the body, not only in the input label.
    expect(screen.getAllByText(new RegExp(EMAIL)).length).toBeGreaterThan(0);
  });

  it('keeps the destructive button disabled until the email is typed exactly', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Harness />);
    expect(confirmButton()).toBeDisabled();

    const input = screen.getByLabelText(/to confirm/i);
    await user.type(input, 'target@example.co'); // one character short
    expect(confirmButton()).toBeDisabled();

    await user.type(input, 'm');
    await waitFor(() => expect(confirmButton()).toBeEnabled());
  });

  it('refuses a case-mismatched confirmation', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Harness />);
    await user.type(screen.getByLabelText(/to confirm/i), EMAIL.toUpperCase());
    expect(confirmButton()).toBeDisabled();
  });

  // THE REGRESSION THIS FILE EXISTS FOR. PlatformOrgMember.email is
  // string | null, so a caller that passes `email ?? ''` hands this dialog an
  // empty string — and an empty `typed` would then equal it on FIRST RENDER,
  // arming the destructive button with zero keystrokes.
  it('never arms the button when the expected email is empty', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = vi.fn();
    render(<Harness email="" onConfirm={onConfirm} />);

    expect(confirmButton()).toBeDisabled();
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();

    // Typing anything at all must not rescue it either.
    await user.type(screen.getByLabelText(/to confirm/i), 'anything');
    expect(confirmButton()).toBeDisabled();
  });
});

describe('DisableAccountDialog — the mandatory reason', () => {
  it('passes the selected category through to onConfirm', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.selectOptions(screen.getByLabelText('Reason'), 'policy_violation');
    await user.type(screen.getByLabelText(/to confirm/i), EMAIL);
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await user.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith({ category: 'policy_violation' });
  });

  it('blocks Other with blank notes and says why', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.selectOptions(screen.getByLabelText('Reason'), 'other');
    await user.type(screen.getByLabelText(/to confirm/i), EMAIL);

    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(/Describe the reason when the category is Other/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Notes/i), 'Duplicate account');
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ category: 'other', notes: 'Duplicate account' });
  });
});

describe('DisableAccountDialog — safety behaviours', () => {
  it('auto-focuses the confirm input so the gate is obvious', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText(/to confirm/i)).toHaveFocus());
  });

  it('swallows a programmatic close while the action is in flight', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = vi.fn();
    render(<Harness pending onOpenChange={onOpenChange} />);

    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('disables Cancel while pending', () => {
    render(<Harness pending />);
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
  });
});
