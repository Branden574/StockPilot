import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('stacks each label above its control, inside the card, on a phone', () => {
    // A long template name pushed its select past the card's edge at 390 px,
    // and "Format" sat beside its select instead of above it.
    render(<LabelSheet items={ITEMS} copies={1} template="medium" />);
    for (const name of ['Template', 'Format', 'Copies per item']) {
      const field = screen.getByLabelText(name).parentElement!;
      expect(field).toHaveClass('flex', 'flex-col', 'min-w-0', 'max-w-full');
    }
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

// The preview on a phone (R6). A sheet is often wider than the screen (one
// Medium label is 4 inches, 384 px), so the preview well scrolls sideways at
// 390 px, and with no tab stop, role or name a keyboard could not reach it
// (axe scrollable-region-focusable, serious; WebKit's Tab went past it). As the
// shared Table's wrapper does, the well is a region named "Label sheet preview"
// in the Tab order only while it scrolls. happy-dom lays nothing out, so the
// widths are given; the lab measured 390, 768, 1024 and 1280 px in Chromium and
// WebKit, with axe.
describe('LabelSheet: the preview while it scrolls sideways', () => {
  let widths = { scroll: 0, client: 0 };
  let resize: ResizeObserverCallback | null = null;

  beforeEach(() => {
    widths = { scroll: 0, client: 0 };
    resize = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          resize = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => widths.scroll);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => widths.client);
  });

  afterEach(() => vi.restoreAllMocks());

  const well = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-slot="label-sheet-preview"]')!;

  // Mutation caught: a stop, role or name on a sheet that fits (an extra,
  // pointless Tab stop and landmark at 1280 px).
  it('is a plain box while the sheet fits', () => {
    widths = { scroll: 986, client: 986 };
    const { container } = render(<LabelSheet items={ITEMS} copies={1} template="medium" />);
    for (const attr of ['role', 'aria-label', 'tabindex']) {
      expect(well(container)).not.toHaveAttribute(attr);
    }
  });

  // Mutation caught: the well without its tab stop or name while it overflows.
  it('is a named region in the Tab order while it scrolls, right after Print', async () => {
    widths = { scroll: 400, client: 356 }; // one 4-inch label in a 390 px phone's well
    const user = userEvent.setup();
    const { container } = render(<LabelSheet items={ITEMS} copies={1} template="medium" />);
    const region = screen.getByRole('region', { name: 'Label sheet preview' });
    expect(region).toBe(well(container));
    expect(region).toHaveAttribute('tabindex', '0');
    screen.getByRole('button', { name: 'Print' }).focus();
    await user.tab();
    expect(region).toHaveFocus();
  });

  // Mutation caught: measuring once on mount only.
  it('starts and stops being a stop as the sheet starts and stops fitting', () => {
    widths = { scroll: 356, client: 356 }; // a thermal label fits
    const { container } = render(<LabelSheet items={ITEMS} copies={1} template="thermal-50x30" />);
    expect(well(container)).not.toHaveAttribute('tabindex');

    widths = { scroll: 804, client: 474 }; // two Medium labels side by side at 768 px
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'medium' } });
    act(() => resize?.([], {} as ResizeObserver));
    expect(well(container)).toHaveAttribute('tabindex', '0');
    expect(well(container)).toHaveAttribute('role', 'region');

    widths = { scroll: 986, client: 986 };
    act(() => resize?.([], {} as ResizeObserver));
    for (const attr of ['role', 'aria-label', 'tabindex']) {
      expect(well(container)).not.toHaveAttribute(attr);
    }
  });

  it('the server HTML carries no measured attribute, so hydration matches', () => {
    widths = { scroll: 400, client: 356 };
    const html = renderToString(<LabelSheet items={ITEMS} copies={1} template="medium" />);
    expect(html).toContain('data-slot="label-sheet-preview"');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('role="region"');
  });
});
