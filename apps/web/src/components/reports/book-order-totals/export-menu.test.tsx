// The Book Order Totals export menu: a file is fetched by the page, so a
// refusal (the hourly export budget, a report that grew past the ceiling
// since the page loaded, a timeout, a lost session) is SAID on the page in
// core's words, instead of vanishing as a failed download or opening a tab
// of raw JSON. A good file is saved under the server's own name. The links
// keep their real hrefs (a new tab or a copied link still works).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOK_REPORT_TIMEOUT,
  DEFAULT_BOOK_REPORT_QUERY,
  bookReportTooManyText,
  type BookReportQuery,
} from '@stockpilot/core';

import { W1 } from './__fixtures__/answers';
import { BookReportExportMenu } from './export-menu';

const Q: BookReportQuery = { ...DEFAULT_BOOK_REPORT_QUERY, warehouse: W1 };
const fetchMock = vi.fn();
const createObjectURL = vi.fn(() => 'blob:book-report');
const revokeObjectURL = vi.fn();

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BookReportExportMenu', () => {
  it('the hourly export budget: says when to try again, from Retry-After', async () => {
    fetchMock.mockResolvedValue(
      json(429, { error: 'rate_limited', message: 'Too many exports' }, { 'retry-after': '700' }),
    );
    render(<BookReportExportMenu query={Q} totalCount={32} />);
    const csv = screen.getByRole('link', { name: /CSV/ });
    expect(csv.getAttribute('href')).toContain(`warehouse=${W1}`);
    await userEvent.click(csv);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many exports in the last hour. Try again in 12 minutes.',
    );
    expect(fetchMock.mock.calls[0]![0]).toBe(csv.getAttribute('href'));
  });

  it('a report that grew past the ceiling since the page loaded: the counts, in core words', async () => {
    fetchMock.mockResolvedValue(
      json(400, {
        error: 'validation_error',
        message: 'x',
        details: { reason: 'too_many_rows', count: 20001, limit: 20000 },
      }),
    );
    render(<BookReportExportMenu query={Q} totalCount={19990} />);
    await userEvent.click(screen.getByRole('link', { name: /CSV/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(bookReportTooManyText(20001, 20000));
  });

  it('a PDF that timed out says so on the page and opens no tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    fetchMock.mockResolvedValue(
      json(503, { error: 'internal_error', message: 'x', details: { reason: 'timeout' } }),
    );
    render(<BookReportExportMenu query={Q} totalCount={32} />);
    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /PDF with covers/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(BOOK_REPORT_TIMEOUT);
    expect(open).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('format=pdf');
  });

  it('no answer at all: a connection problem, never silence', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<BookReportExportMenu query={Q} totalCount={32} />);
    await userEvent.click(screen.getByRole('link', { name: /CSV/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The file could not be downloaded. Check the connection and try again.',
    );
  });

  it('a good file is saved under the server name, and a new try clears the last refusal', async () => {
    fetchMock
      .mockResolvedValueOnce(json(500, { error: 'internal_error', message: 'x' }))
      .mockResolvedValueOnce(
        new Response('a,b\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="book-order-totals_2026-09-28.csv"',
          },
        }),
      );
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(`${this.download}|${this.href}`);
    });
    render(<BookReportExportMenu query={Q} totalCount={32} />);
    const csv = screen.getByRole('link', { name: /CSV/ });
    await userEvent.click(csv);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server had a problem. Try again in a moment.',
    );
    await userEvent.click(csv);
    await waitFor(() =>
      expect(clicks).toEqual(['book-order-totals_2026-09-28.csv|blob:book-report']),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    click.mockRestore();
  });
});
