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

  // Walk defect 2026-09-28: after "PDF with covers" or "PDF without covers"
  // the file arrived but the menu stayed open, the page kept Radix's modal
  // pointer lock and the PDF button was hidden from assistive technology
  // until Escape. The menu must close as soon as a file is chosen, while the
  // file is still being prepared, and stay closed when it is saved.
  it.each([
    ['PDF with covers', 'format=pdf', false],
    ['PDF without covers', 'photos=0', true],
  ])('choosing "%s" closes the menu at once and the file is saved', async (label, inUrl, plain) => {
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    const saved: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      if (this.href.startsWith('blob:')) saved.push(`${this.download}|${this.href}`);
      else realClick.call(this);
    });
    render(<BookReportExportMenu query={Q} totalCount={32} />);
    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: new RegExp(label) }));

    // While the file is prepared: the menu is gone and the page is usable.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
    expect(screen.getByRole('button', { name: 'PDF' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/Preparing the file/)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]![0])).toContain(inUrl);
    expect(String(fetchMock.mock.calls[0]![0]).includes('photos=0')).toBe(plain);

    answer(
      new Response(new Blob(['%PDF-1.7']), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="book-order-totals_2026-09-28.pdf"',
        },
      }),
    );
    await waitFor(() =>
      expect(saved).toEqual(['book-order-totals_2026-09-28.pdf|blob:book-report']),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'PDF' })).not.toHaveAttribute('aria-busy'),
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    click.mockRestore();
  });

  it('a refused PDF chosen from the keyboard: the menu closes, the reason shows, focus is on PDF', async () => {
    const user = userEvent.setup();
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    render(<BookReportExportMenu query={Q} totalCount={32} />);
    screen.getByRole('button', { name: 'PDF' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /PDF with covers/ })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');

    // Closed while the file is prepared, and focus back on the PDF button
    // (never lost to the page body because the button was busy).
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'PDF' })).toHaveFocus());

    answer(json(429, { error: 'rate_limited', message: 'x' }, { 'retry-after': '700' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many exports in the last hour. Try again in 12 minutes.',
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'PDF' })).toHaveFocus();

    // And it can be used again at once from the keyboard.
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
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
