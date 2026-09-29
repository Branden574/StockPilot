import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PdfDownloadDropdown } from './pdf-download-dropdown';

/** The page is usable again: no menu, no modal pointer lock, and the PDF
 *  button back in the accessibility tree (Radix hides everything outside an
 *  open modal menu with aria-hidden, which getByRole honours). */
async function expectMenuClosedAndPageUsable() {
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
  expect(screen.getByRole('button', { name: 'PDF' })).toBeInTheDocument();
}

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

  // The page fetches the file itself (onDownload). Stopping the link's own
  // navigation must not also stop the menu closing: before this, the menu
  // stayed open with the page locked behind it until Escape.
  it('with onDownload, a click hands over the URL and closes the menu', async () => {
    const onDownload = vi.fn();
    render(
      <PdfDownloadDropdown
        baseUrl="/api/v1/reports/book-order-totals/export?format=pdf"
        labels={{ withImages: 'PDF with covers', withoutImages: 'PDF without covers' }}
        onDownload={onDownload}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /PDF with covers/ }));
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/reports/book-order-totals/export?format=pdf',
    );
    await expectMenuClosedAndPageUsable();

    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /PDF without covers/ }));
    expect(onDownload).toHaveBeenLastCalledWith(
      '/api/v1/reports/book-order-totals/export?format=pdf&photos=0',
    );
    await expectMenuClosedAndPageUsable();
  });

  it('with onDownload, the keyboard chooses a file, the menu closes and focus returns to PDF', async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    render(
      <PdfDownloadDropdown
        baseUrl="/x/pdf"
        labels={{ withImages: 'PDF with covers', withoutImages: 'PDF without covers' }}
        onDownload={onDownload}
      />,
    );
    screen.getByRole('button', { name: 'PDF' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /PDF without covers/ })).toHaveFocus(),
    );
    await user.keyboard('{Enter}');
    expect(onDownload).toHaveBeenCalledExactlyOnceWith('/x/pdf?photos=0');
    await expectMenuClosedAndPageUsable();
    await waitFor(() => expect(screen.getByRole('button', { name: 'PDF' })).toHaveFocus());
  });

  it('a modified click (new tab) is left to the browser and still closes the menu', async () => {
    const onDownload = vi.fn();
    // What the component left to the browser: whether the click reached the
    // document with its default still allowed. The document listener runs
    // after React's (and so after the menu's own select), then stops the
    // test DOM from actually following the link (it would fetch it).
    const leftToBrowser: boolean[] = [];
    const stopNavigation = (e: MouseEvent) => {
      leftToBrowser.push(!e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener('click', stopNavigation);
    try {
      render(<PdfDownloadDropdown baseUrl="/x/pdf" onDownload={onDownload} />);
      await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
      const item = await screen.findByRole('menuitem', { name: /With images/ });
      const user = userEvent.setup();
      await user.keyboard('{Meta>}');
      await user.click(item);
      await user.keyboard('{/Meta}');
      expect(onDownload).not.toHaveBeenCalled();
      expect(leftToBrowser.at(-1)).toBe(true);
      await expectMenuClosedAndPageUsable();
    } finally {
      document.removeEventListener('click', stopNavigation);
    }
  });

  it('while a file is being prepared the button says so, stays focusable and does not open', async () => {
    const onDownload = vi.fn();
    render(<PdfDownloadDropdown baseUrl="/x/pdf" onDownload={onDownload} busy />);
    const button = screen.getByRole('button', { name: 'PDF' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('is disabled, with the reason beside it, when the file cannot be made', () => {
    render(<PdfDownloadDropdown baseUrl="/x" disabledReason="Too many books for one file." />);
    const button = screen.getByRole('button', { name: 'PDF' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Too many books for one file.');
  });
});
