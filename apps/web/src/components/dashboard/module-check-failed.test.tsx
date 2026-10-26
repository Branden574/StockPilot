import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "could not check" state (docket R7). A module set that could not be read
 * is not "module off": this panel says the check failed and offers Try again,
 * which asks the server for the page again (router.refresh), never a link to
 * the same URL the client router may answer from its 90 s cache.
 */

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { ModuleCheckFailed } from './module-check-failed';
import { TryAgainButton } from './try-again-button';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ModuleCheckFailed', () => {
  it('names the module in the page h1, says it is usually temporary, and offers Try again', () => {
    const { container } = render(<ModuleCheckFailed moduleId="po_imports" />);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: "We couldn't check whether PO imports is on" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('This is usually temporary. Try again in a moment.'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-state-kind]')).toHaveAttribute(
      'data-state-kind',
      'failed',
    );
    // Not the module-off panel: no "isn't enabled", no way to switch it on.
    expect(screen.queryByText(/isn.t enabled/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Try again asks the server for the page again', () => {
    render(<ModuleCheckFailed moduleId="rentals" />);
    expect(
      screen.getByRole('heading', { level: 1, name: "We couldn't check whether Rentals is on" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('TryAgainButton', () => {
  it('is a plain button that stays enabled, so keyboard focus stays on it', () => {
    render(<TryAgainButton aria-describedby="why" />);
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveAttribute('aria-describedby', 'why');
    // The refresh icon is decoration, never part of the name.
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('refreshes on each press, and not when its own onClick prevents it', () => {
    const onClick = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const { rerender } = render(<TryAgainButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<TryAgainButton onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
