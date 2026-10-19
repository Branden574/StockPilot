import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The label sheet (P4.A1, matrix W-IT-07). The redesign themes only the
// on-screen controls: they are labelled now (the Template, Format and Copies
// boxes had labels that named nothing), the empty state is the shared state
// panel with the same words, and the sheet sits on a recessed well on screen.
// What prints never changes: white labels in black ink, @page per template,
// one label per page on a thermal roll, and nothing but the labels on paper.

vi.mock('jsbarcode', () => ({ default: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,') } }));

import { LabelSheet } from './label-sheet';

const ITEMS = [
  { id: 'i-1', name: 'Wireless mouse', sku: 'SP-MOUSE-001', barcode: '0123456789012' },
  { id: 'i-2', name: 'Keyboard', sku: 'SP-KEY-001', barcode: null },
];

afterEach(() => vi.unstubAllGlobals());

function printCss(container: HTMLElement): string {
  return Array.from(container.ownerDocument.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
}

describe('LabelSheet', () => {
  it('labels its controls and prints from the Print button', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    render(<LabelSheet items={ITEMS} copies={2} template="medium" />);
    expect(screen.getByLabelText('Template')).toHaveValue('medium');
    expect(screen.getByLabelText('Format')).toHaveValue('barcode');
    expect(screen.getByLabelText('Copies per item')).toHaveValue(2);
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('draws each label white with black ink, copies included, with its code under it', () => {
    const { container } = render(<LabelSheet items={ITEMS} copies={2} template="small" />);
    const cells = container.querySelectorAll<HTMLElement>('.label-print-page .label-cell');
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.style.background).toMatch(/#fff|rgb\(255, 255, 255\)/);
      expect(cell.style.color).toMatch(/#000|rgb\(0, 0, 0\)/);
    }
    expect(cells[0]).toHaveTextContent('Wireless mouse');
    expect(cells[0]).toHaveTextContent('0123456789012');
    // No barcode: the SKU is printed instead.
    expect(cells[2]).toHaveTextContent('SP-KEY-001');
  });

  it('keeps the print rules: the page size per template, paper white, only the labels shown', () => {
    const { container } = render(<LabelSheet items={ITEMS} copies={1} template="medium" />);
    const css = printCss(container);
    expect(css).toMatch(/@page\s*{\s*size:\s*letter;\s*margin:\s*0\.5in;/);
    expect(css).toMatch(/background:\s*#fff\s*!important/);
    expect(css).toMatch(/body \*\s*{\s*visibility:\s*hidden\s*!important;/);
    expect(css).toMatch(/\.label-print-page \*\s*{\s*visibility:\s*visible\s*!important;/);
  });

  it('prints one label per page on a thermal roll, with no cut guide', () => {
    const { container } = render(<LabelSheet items={ITEMS} copies={1} template="thermal-50x30" />);
    expect(container.querySelector('.label-grid--thermal')).not.toBeNull();
    const css = printCss(container);
    expect(css).toMatch(/size:\s*50mm 30mm;\s*margin:\s*0;/);
    expect(css).toMatch(
      /\.label-grid--thermal \.label-cell\s*{\s*border:\s*none\s*!important;\s*page-break-after:\s*always;/,
    );
  });

  it('hides the controls and the screen well on paper', () => {
    const { container } = render(<LabelSheet items={ITEMS} copies={1} template="medium" />);
    expect(container.querySelector('[data-slot="label-sheet-controls"]')).toHaveClass(
      'print:hidden',
    );
    const well = container.querySelector('[data-slot="label-sheet-preview"]')!;
    expect(well).toHaveClass('print:bg-transparent', 'print:border-0', 'print:p-0');
    expect(well).toContainElement(container.querySelector('.label-print-page') as HTMLElement);
  });

  it('says how to pick items when there are none, in the shared state panel', () => {
    const { container } = render(<LabelSheet items={[]} copies={1} template="medium" />);
    expect(
      screen.getByText(
        'No items selected. Go to the inventory list, pick rows, and use the "Print labels" bulk action.',
      ),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-state-kind="empty"]')).toHaveClass('print:hidden');
    expect(screen.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument();
  });
});
