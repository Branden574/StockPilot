import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PdfDownloadDropdown } from './pdf-download-dropdown';

// Every report's PDF menu. The optional labels, note and disabled reason are
// for Book Order Totals; a caller that passes none renders as it always did.

describe('PdfDownloadDropdown', () => {
  it('offers the two files with the old words when given only a URL', async () => {
    render(<PdfDownloadDropdown baseUrl="/api/reports/x/pdf?days=30" />);
    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    expect(await screen.findByRole('menuitem', { name: /With images/ })).toHaveAttribute(
      'href',
      '/api/reports/x/pdf?days=30',
    );
    expect(screen.getByRole('menuitem', { name: /Without images/ })).toHaveAttribute(
      'href',
      '/api/reports/x/pdf?days=30&photos=0',
    );
  });

  it('shows a disclosure before the download and uses the given words', async () => {
    render(
      <PdfDownloadDropdown
        baseUrl="/api/v1/reports/book-order-totals/export?format=pdf&warehouse=all"
        labels={{ withImages: 'PDF with covers', withoutImages: 'PDF without covers' }}
        note="Covers for the first 500 books; every row and total is included."
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    expect(
      await screen.findByText('Covers for the first 500 books; every row and total is included.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /PDF without covers/ })).toHaveAttribute(
      'href',
      '/api/v1/reports/book-order-totals/export?format=pdf&warehouse=all&photos=0',
    );
  });

  it('is disabled, with the reason beside it, when the file cannot be made', () => {
    render(<PdfDownloadDropdown baseUrl="/x" disabledReason="Too many books for one file." />);
    const button = screen.getByRole('button', { name: 'PDF' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Too many books for one file.');
  });
});
