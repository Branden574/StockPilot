import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import {
  CYCLE_COUNT_SEARCH_DEBOUNCE_MS,
  CycleCountHistorySearch,
} from './cycle-count-history-search';

beforeEach(() => {
  vi.useFakeTimers();
  router.replace.mockClear();
  router.push.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

function box() {
  return screen.getByLabelText('Search cycle counts') as HTMLInputElement;
}

describe('CycleCountHistorySearch', () => {
  it('waits for typing to settle, then REPLACES the URL once, back on page 1', () => {
    render(<CycleCountHistorySearch initialQuery="" status="completed" />);
    fireEvent.change(box(), { target: { value: 'C' } });
    fireEvent.change(box(), { target: { value: 'CC' } });
    fireEvent.change(box(), { target: { value: 'CC-42' } });
    act(() => vi.advanceTimersByTime(CYCLE_COUNT_SEARCH_DEBOUNCE_MS - 1));
    expect(router.replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/dashboard/cycle-counts?q=CC-42&status=completed', {
      scroll: false,
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('searches at once on Enter', () => {
    render(<CycleCountHistorySearch initialQuery="" status={null} />);
    fireEvent.change(box(), { target: { value: '42' } });
    fireEvent.submit(box().closest('form')!);
    expect(router.replace).toHaveBeenCalledWith('/dashboard/cycle-counts?q=42', { scroll: false });
    act(() => vi.advanceTimersByTime(CYCLE_COUNT_SEARCH_DEBOUNCE_MS * 2));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  it('clears at once and keeps the status filter', () => {
    render(<CycleCountHistorySearch initialQuery="north" status="canceled" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box().value).toBe('');
    expect(router.replace).toHaveBeenCalledWith('/dashboard/cycle-counts?status=canceled', { scroll: false });
  });

  it('does not navigate for whitespace-only edits of the applied query', () => {
    render(<CycleCountHistorySearch initialQuery="north" status={null} />);
    fireEvent.change(box(), { target: { value: 'north  ' } });
    act(() => vi.advanceTimersByTime(CYCLE_COUNT_SEARCH_DEBOUNCE_MS * 2));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('follows the URL when it changes from outside (Back / Forward)', () => {
    const { rerender } = render(<CycleCountHistorySearch initialQuery="CC-42" status={null} />);
    rerender(<CycleCountHistorySearch initialQuery="north" status={null} />);
    expect(box().value).toBe('north');
    act(() => vi.advanceTimersByTime(CYCLE_COUNT_SEARCH_DEBOUNCE_MS * 2));
    // Adopting the URL's query is not a new search.
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('caps the input length', () => {
    render(<CycleCountHistorySearch initialQuery="" status={null} />);
    expect(box()).toHaveAttribute('maxLength', '100');
  });
});
