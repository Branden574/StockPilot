import { waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/**
 * Press a button once it is enabled.
 *
 * A form that saves inside a transition can show a dialog before the
 * transition has ended, with its buttons disabled until it has: the new-rack
 * question appears from inside the save's startTransition, and
 * PlacementConfirmDialog's buttons follow `submitting`. A person cannot press
 * that fast, but a test can. On a loaded runner a press landed on the still
 * disabled Go back, did nothing, and the question stayed open (CI run
 * 40202489838). Waiting for the button to be enabled, as a person would, keeps
 * these tests about the dialog and not about the runner's speed.
 */
export async function pressWhenEnabled(user: UserEvent, button: HTMLElement): Promise<void> {
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}
