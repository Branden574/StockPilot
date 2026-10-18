import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';

/**
 * Redesign P2.2 overlays: the look changed (card surface, radius 8, quiet
 * shadow), the behaviour did not (focus trap, Escape, the Close button's name).
 *
 * Defect fixed here: the built-in close X was a bare 16 px icon, below the
 * 24 px minimum target; it is now a 28 px button with the icon where it was.
 */

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

function Harness() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Group selected</DialogTitle>
            <DialogDescription>3 records will be grouped.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline">Cancel</Button>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('keeps its name, its Close button and Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Group selected' });
    expect(dialog).toHaveAccessibleDescription('3 records will be grouped.');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('state')).toHaveTextContent('closed');
  });

  it('the Close button is a 28 px target that closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(classes(close)).toEqual(expect.arrayContaining(['h-7', 'w-7']));
    await user.click(close);
    expect(screen.getByTestId('state')).toHaveTextContent('closed');
  });

  it('draws the card surface with radius 8 and no blur', () => {
    render(<Harness />);
    const c = classes(screen.getByRole('dialog'));
    expect(c).toEqual(expect.arrayContaining(['bg-card', 'rounded-lg', 'border']));
    expect(c.some((x) => x.startsWith('backdrop-blur'))).toBe(false);
  });

  it('the footer keeps a gap between stacked buttons on phones', () => {
    render(<Harness />);
    const footer = screen.getByRole('button', { name: 'Save' }).parentElement!;
    expect(classes(footer)).toEqual(
      expect.arrayContaining(['flex-col-reverse', 'gap-2', 'sm:flex-row']),
    );
  });
});

describe('Sheet', () => {
  it('the built-in Close is a 28 px target; hideClose still removes it', () => {
    const { rerender } = render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>What&apos;s new</SheetTitle>
          <SheetDescription>October release</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(classes(screen.getByRole('button', { name: 'Close' }))).toEqual(
      expect.arrayContaining(['h-7', 'w-7']),
    );
    rerender(
      <Sheet open>
        <SheetContent hideClose>
          <SheetTitle>What&apos;s new</SheetTitle>
          <SheetDescription>October release</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
