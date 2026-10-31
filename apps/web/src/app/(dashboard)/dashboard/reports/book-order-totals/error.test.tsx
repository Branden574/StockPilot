import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BOOK_REPORT_LOAD_ERROR } from '@stockpilot/core';

// The report's own error boundary (W-RP-14d): the way back, the title, the
// load error as an alert with its error id, and Try again. Never cards,
// zeros or an empty table that would read as "no orders".

const reported = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/lib/error-reporter-core', () => ({
  reportError: vi.fn(async (...args: unknown[]) => {
    reported.calls.push(args);
  }),
}));

import BookOrderTotalsError from './error';

beforeEach(() => {
  reported.calls = [];
});

describe('Book Order Totals error boundary', () => {
  it('says the report could not be read, with the error id and Try again', async () => {
    const retry = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });
    render(<BookOrderTotalsError error={error} retry={retry} />);

    expect(screen.getByRole('link', { name: '← Back to reports' })).toHaveAttribute(
      'href',
      '/dashboard/reports',
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Book Order Totals' }),
    ).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(BOOK_REPORT_LOAD_ERROR);
    expect(alert).toHaveTextContent('Error id: abc123');
    expect(alert).toHaveAttribute('data-state-kind', 'failed');
    // No figures, no table.
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reported.calls[0]?.[1]).toMatchObject({
      tag: 'reports.book_order_totals.render',
      extra: { digest: 'abc123' },
    });
  });

  it('falls back to reset, and prints no error id line without a digest', async () => {
    const reset = vi.fn();
    render(<BookOrderTotalsError error={new Error('boom')} reset={reset} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error id');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
