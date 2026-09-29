import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { KEY_CHANGE_WINDOW_MS, useCommittedSelect, type CommitHow } from './use-committed-select';

// The one-request-per-choice hook (plan D16), on its own. The filter bar
// test sweeps every select of the report through it; this file pins the
// edges: keyboard browsing never commits by itself (no timer: a screen
// reader may pause on an option as long as it likes), Enter and leaving the
// select do, a choice made in the browser's own list commits at once, an
// answer landing while a keyboard draft waits, an unmount, and reset().

function Pick({
  committed,
  onCommit,
  withReset = false,
}: {
  committed: string;
  onCommit: (v: string, how: CommitHow) => void;
  withReset?: boolean;
}) {
  const select = useCommittedSelect(committed, onCommit);
  return (
    <>
      <select aria-label="Choice" {...select.props}>
        {['a', 'b', 'c', 'd'].map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {withReset ? (
        <button type="button" onClick={select.reset}>
          Reset
        </button>
      ) : null}
    </>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Windows Chrome and Edge on a CLOSED select: the key moves the value and
 *  fires `change` in the same task. */
function arrowTo(select: HTMLElement, value: string, key = 'ArrowDown') {
  fireEvent.keyDown(select, { key });
  fireEvent.change(select, { target: { value } });
}

describe('useCommittedSelect', () => {
  it('keyboard browsing never commits by itself: a long pause on an option changes nothing (WCAG 3.2.2)', async () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'b');
    arrowTo(select, 'c');
    expect(select).toHaveValue('c');
    // A screen reader reading the option name, or a person thinking.
    await wait(1000);
    expect(onCommit).not.toHaveBeenCalled();
  }, 15000);

  it('Enter commits the draft once, with the last value', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'b');
    arrowTo(select, 'c');
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('c', 'enter');
    fireEvent.blur(select);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('leaving the select commits the draft once, and says so', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'd');
    fireEvent.blur(select);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('d', 'blur');
  });

  it("a choice made in the browser's own list commits at once, even after a key opened the list (macOS, a screen reader, a phone)", async () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    // The key opens the list; the value does not move.
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    await wait(KEY_CHANGE_WINDOW_MS + 50);
    // The choice arrives later, from the list (its own keys never reach the page).
    fireEvent.change(select, { target: { value: 'c' } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('c', 'choice');
  }, 15000);

  it('Enter that picks in an open list commits at once', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'Enter' });
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onCommit).toHaveBeenCalledWith('b', 'enter');
  });

  it('a pointer or touch choice commits at once, also right after a key', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.pointerDown(select);
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onCommit).toHaveBeenCalledWith('b', 'choice');
    // A bare change (no key, no pointer): at once too.
    fireEvent.change(select, { target: { value: 'c' } });
    expect(onCommit).toHaveBeenLastCalledWith('c', 'choice');
  });

  it('back to the committed value commits nothing', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'b');
    arrowTo(select, 'a', 'ArrowUp');
    fireEvent.blur(select);
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows the keyboard draft, and follows a new committed value from outside (an answer, Back) without committing the stale draft', () => {
    const onCommit = vi.fn();
    const view = render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'b');
    expect(select).toHaveValue('b');
    // The answer for "d" lands (Back, or another control) before the choice.
    view.rerender(<Pick committed="d" onCommit={onCommit} />);
    expect(select).toHaveValue('d');
    fireEvent.blur(select);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('an unmount while a keyboard draft waits commits nothing', async () => {
    const onCommit = vi.fn();
    const view = render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'c');
    view.unmount();
    await wait(200);
    expect(onCommit).not.toHaveBeenCalled();
  }, 15000);

  it('onCommit may refuse a choice (return false): the select shows the committed value again', () => {
    const onCommit = vi.fn((_v: string, how: CommitHow) => (how === 'blur' ? false : undefined));
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'c');
    fireEvent.blur(select);
    expect(onCommit).toHaveBeenCalledWith('c', 'blur');
    expect(select).toHaveValue('a');
    // Nothing is left pending: leaving again commits nothing.
    fireEvent.blur(select);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('reset() puts the draft back on the committed value and drops a pending commit', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} withReset />);
    const select = screen.getByLabelText('Choice');
    arrowTo(select, 'c');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(select).toHaveValue('a');
    fireEvent.blur(select);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
