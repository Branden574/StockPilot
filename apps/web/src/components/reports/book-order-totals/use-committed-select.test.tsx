import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { COMMITTED_SELECT_IDLE_MS, useCommittedSelect } from './use-committed-select';

// The one-request-per-choice hook (plan D16), on its own. The filter bar
// test sweeps every select of the report through it; this file pins the
// edges: an answer landing while a keyboard draft waits, an unmount while a
// draft waits, and reset().

function Pick({
  committed,
  onCommit,
  withReset = false,
}: {
  committed: string;
  onCommit: (v: string) => void;
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

async function waitForCall(fn: ReturnType<typeof vi.fn>, timeout: number): Promise<void> {
  const until = performance.now() + timeout;
  while (fn.mock.calls.length === 0 && performance.now() < until) await wait(10);
}

describe('useCommittedSelect', () => {
  it('shows the keyboard draft, and follows a new committed value from outside (an answer, Back) without committing the stale draft', async () => {
    const onCommit = vi.fn();
    const view = render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.change(select, { target: { value: 'b' } });
    expect(select).toHaveValue('b');
    // The answer for "d" lands (Back, or another control) before the draft
    // settles.
    view.rerender(<Pick committed="d" onCommit={onCommit} />);
    expect(select).toHaveValue('d');
    fireEvent.blur(select);
    await wait(COMMITTED_SELECT_IDLE_MS + 100);
    expect(onCommit).not.toHaveBeenCalled();
  }, 15000);

  it('an unmount while a keyboard draft waits commits nothing later', async () => {
    const onCommit = vi.fn();
    const view = render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.change(select, { target: { value: 'c' } });
    view.unmount();
    await wait(COMMITTED_SELECT_IDLE_MS + 100);
    expect(onCommit).not.toHaveBeenCalled();
  }, 15000);

  it('a key that moves nothing restarts the wait for a pending draft', async () => {
    // Measured, not raced: the commit must come a full idle time after the
    // LAST key, not after the change (CI runs about four times slower).
    let committedAt = 0;
    const onCommit = vi.fn(() => {
      committedAt = performance.now();
    });
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.change(select, { target: { value: 'b' } });
    await wait(100);
    expect(onCommit).not.toHaveBeenCalled();
    const lastKeyAt = performance.now();
    fireEvent.keyDown(select, { key: 'ArrowDown' }); // at the end of the list: no change
    await waitForCall(onCommit, 5000);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('b');
    expect(committedAt - lastKeyAt).toBeGreaterThanOrEqual(COMMITTED_SELECT_IDLE_MS - 25);
  }, 15000);

  it('reset() puts the draft back on the committed value and drops a pending commit', async () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} withReset />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.change(select, { target: { value: 'c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(select).toHaveValue('a');
    fireEvent.blur(select);
    await wait(COMMITTED_SELECT_IDLE_MS + 100);
    expect(onCommit).not.toHaveBeenCalled();
  }, 15000);

  it('after a pointer choice, the keyboard no longer delays (and the reverse)', () => {
    const onCommit = vi.fn();
    render(<Pick committed="a" onCommit={onCommit} />);
    const select = screen.getByLabelText('Choice');
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.pointerDown(select);
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onCommit).toHaveBeenCalledWith('b');
  });
});
