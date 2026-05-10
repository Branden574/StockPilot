import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyboardShortcutsProvider, openKeyboardShortcutsOverlay } from './keyboard-shortcuts';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn() }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  pushMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function dispatch(key: string, opts: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
  });
}

describe('KeyboardShortcutsProvider', () => {
  it('opens the overlay when "?" is pressed', () => {
    render(<KeyboardShortcutsProvider />);
    expect(screen.queryByText('Keyboard shortcuts')).not.toBeInTheDocument();
    dispatch('?');
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
  });

  it('opens the overlay via the openKeyboardShortcutsOverlay helper', () => {
    render(<KeyboardShortcutsProvider />);
    act(() => {
      openKeyboardShortcutsOverlay();
    });
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
  });

  it('navigates to /dashboard/inventory on "g" then "i"', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('g');
    dispatch('i');
    expect(pushMock).toHaveBeenCalledWith('/dashboard/inventory');
  });

  it('navigates to /dashboard/settings on "g" then ","', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('g');
    dispatch(',');
    expect(pushMock).toHaveBeenCalledWith('/dashboard/settings');
  });

  it('navigates to /dashboard/inventory/new on "n" then "i"', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('n');
    dispatch('i');
    expect(pushMock).toHaveBeenCalledWith('/dashboard/inventory/new');
  });

  it('clears the prefix after the 1.5s timeout', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('g');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    dispatch('i');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('resets the prefix and does not navigate on an unknown completion key', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('g');
    dispatch('x'); // not a registered second key
    expect(pushMock).not.toHaveBeenCalled();
    // Subsequent "i" alone should NOT trigger inventory either (prefix was cleared)
    dispatch('i');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not navigate when focus is in an input', () => {
    render(
      <>
        <input data-testid="text-input" />
        <KeyboardShortcutsProvider />
      </>,
    );
    const input = screen.getByTestId('text-input') as HTMLInputElement;
    input.focus();
    dispatch('g');
    dispatch('i');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not open the overlay from "?" while typing in an input', () => {
    render(
      <>
        <input data-testid="text-input" />
        <KeyboardShortcutsProvider />
      </>,
    );
    const input = screen.getByTestId('text-input') as HTMLInputElement;
    input.focus();
    // Many browsers fire keydown with key='?' when shift+/ is pressed inside
    // an input. The provider must NOT open the overlay in that case.
    dispatch('?');
    expect(screen.queryByText('Keyboard shortcuts')).not.toBeInTheDocument();
  });

  it('ignores chords with modifier keys so it does not steal ⌘K', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('k', { metaKey: true });
    expect(pushMock).not.toHaveBeenCalled();
    // "?" with ctrl should also be ignored (browser shortcuts).
    dispatch('?', { ctrlKey: true });
    expect(screen.queryByText('Keyboard shortcuts')).not.toBeInTheDocument();
  });

  it('renders every nav shortcut row in the overlay', () => {
    render(<KeyboardShortcutsProvider />);
    dispatch('?');
    // A representative sample — keeps the test resilient while still
    // covering each section.
    expect(screen.getByText('Inventory items')).toBeInTheDocument();
    expect(screen.getByText('New item')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText(/Open command palette/)).toBeInTheDocument();
  });

  it('cleans up the listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<KeyboardShortcutsProvider />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('clears the pending prefix when focus moves into an input', () => {
    render(
      <>
        <input data-testid="text-input" />
        <KeyboardShortcutsProvider />
      </>,
    );
    dispatch('g'); // arm
    const input = screen.getByTestId('text-input') as HTMLInputElement;
    input.focus();
    // The next keystroke happens inside the input; the listener should
    // clear the prefix and NOT navigate when focus later returns.
    dispatch('i');
    expect(pushMock).not.toHaveBeenCalled();
    input.blur();
    dispatch('i');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
