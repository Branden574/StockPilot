import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BarcodeDisplay } from './barcode-display';

// The label's print window (redesign Stage 6, LABEL-PRINT-VIEWPORT). Print
// opens a 420 x 600 window that holds the one label and prints it. Its
// document had no viewport meta, so a phone laid that window out 980 css px
// wide (980 x 1400) and showed the label zoomed out before the print dialog.
// Its head now says width=device-width, initial-scale=1. What prints does not
// change: the @page size, the label box and the box inside it keep the same
// rules for every label size.

let blobs: Blob[];
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  blobs = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    ),
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
    blobs.push(b as Blob);
    return `blob:label/${blobs.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  open = vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Opens the label dialog, picks a size (and Rotate 90°), presses Print and
 *  reads the document the print window was given. */
async function printWindowDocument(size?: string, rotate = false) {
  render(<BarcodeDisplay itemId="item-1" itemName="Wireless Mouse" sku="WM-1" barcode="WM-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  const print = await screen.findByRole('button', { name: 'Print' });
  await waitFor(() => expect(print).toBeEnabled());
  if (size) fireEvent.change(screen.getByLabelText('Label size'), { target: { value: size } });
  if (rotate) fireEvent.click(screen.getByRole('checkbox', { name: /Rotate 90°/ }));
  fireEvent.click(print);
  expect(open).toHaveBeenCalledTimes(1);
  const html = blobs.filter((b) => b.type === 'text/html');
  expect(html).toHaveLength(1);
  const doc = new DOMParser().parseFromString(await html[0]!.text(), 'text/html');
  const css = doc.head.querySelector('style')?.textContent ?? '';
  return { doc, css, call: open.mock.calls[0]! };
}

const squash = (s: string) => s.replace(/\s+/g, '');
const inch = (mm: number) => `${mm / 25.4}in`;

describe('BarcodeDisplay: the print window', () => {
  // Mutation caught: the head without the viewport meta (a phone lays the
  // window out at 980 css px and shows the label zoomed out), or a viewport
  // that stops the person zooming.
  it('lays the window out at the width of the screen it opens on (viewport meta in the head)', async () => {
    const { doc, call } = await printWindowDocument();
    const viewports = doc.head.querySelectorAll('meta[name="viewport"]');
    expect(viewports).toHaveLength(1);
    expect(viewports[0]!.getAttribute('content')).toBe('width=device-width, initial-scale=1');
    // The charset is still the head's first element, and the title is kept.
    expect(doc.head.firstElementChild?.getAttribute('charset')).toBe('utf-8');
    expect(doc.title).toBe('Label');
    // The same 420 x 600 window, given the label's picture, name and SKU.
    const [url, target, features] = call as [string, string, string];
    expect(url).toMatch(/^blob:label\/2#/);
    expect(Object.fromEntries(new URLSearchParams(url.split('#')[1]))).toEqual({
      src: 'blob:label/1',
      t: 'Wireless Mouse',
      s: 'WM-1',
    });
    expect([target, features]).toEqual(['_blank', 'width=420,height=600']);
  });

  // What prints is the same as before the viewport meta: these are the rules
  // the window had, size by size.
  it.each([
    {
      name: 'Fit to printer (auto)',
      size: undefined,
      rotate: false,
      page: 'auto',
      box: 'width:100%;height:100vh;',
      inner: 'width:100%;height:100%;',
      transform: 'translate(-50%,-50%)',
    },
    {
      name: 'Thermal roll 50 x 30 mm',
      size: 'thermal-50x30',
      rotate: false,
      page: '50mm 30mm',
      box: `width:${inch(50)};height:${inch(30)};`,
      inner: `width:${inch(50)};height:${inch(30)};`,
      transform: 'translate(-50%,-50%)',
    },
    {
      name: 'Thermal roll 50 x 30 mm, Rotate 90°',
      size: 'thermal-50x30',
      rotate: true,
      page: '50mm 30mm',
      box: `width:${inch(50)};height:${inch(30)};`,
      inner: `width:${inch(30)};height:${inch(50)};`,
      transform: 'translate(-50%,-50%) rotate(90deg)',
    },
    {
      name: 'Medium (Avery 5163) on letter',
      size: 'medium',
      rotate: false,
      page: 'letter',
      box: 'width:4in;height:2in;',
      inner: 'width:4in;height:2in;',
      transform: 'translate(-50%,-50%)',
    },
    {
      name: 'Custom size, 50 x 30 mm',
      size: 'custom',
      rotate: false,
      page: '50mm 30mm',
      box: `width:${inch(50)};height:${inch(30)};`,
      inner: `width:${inch(50)};height:${inch(30)};`,
      transform: 'translate(-50%,-50%)',
    },
  ])('keeps what prints for $name: the @page size and the label box', async (c) => {
    const { css } = await printWindowDocument(c.size, c.rotate);
    const flat = squash(css);
    expect(flat).toContain(squash(`@page { size: ${c.page}; margin: 0; }`));
    expect(flat).toContain(squash('html,body{margin:0;padding:0;background:#fff;}'));
    expect(flat).toContain(
      squash(`.lbl{ box-sizing:border-box;${c.box} position:relative;overflow:hidden;`),
    );
    expect(flat).toContain(
      squash(
        `.inner{ box-sizing:border-box;${c.inner} position:absolute;top:50%;left:50%;transform:${c.transform};`,
      ),
    );
    // Nothing in the print rules reads the viewport.
    expect(css).not.toMatch(/device-width|@viewport|zoom/);
  });
});

// The dialog at phone width (R1). Its content is a grid whose one implicit
// column took the width of the label-size select, and a select is as wide as
// its longest option: at 16 px, the size that keeps iOS from zooming into the
// field, "Thermal roll · 50 × 80 mm (Phomemo large)" made the select 370 px and
// the column 410 px in a 340 px dialog at 390 px, so Print showed as a 27 px
// sliver past the dialog's edge (33 px in WebKit). happy-dom lays nothing out;
// the lab measured the fix from 320 to 1280 px in Chromium and WebKit. These
// pin what holds it.
describe('BarcodeDisplay: the dialog at phone width', () => {
  async function openDialog() {
    render(<BarcodeDisplay itemId="item-1" itemName="Wireless Mouse" sku="WM-1" barcode="WM-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Label' }));
    return screen.findByRole('dialog', { name: 'Print label' });
  }

  // Mutation caught: the dialog's implicit auto column, which grows to the
  // widest thing in it.
  it('keeps one column no wider than the dialog', async () => {
    const dialog = await openDialog();
    expect(dialog).toHaveClass('grid', 'grid-cols-[minmax(0,1fr)]');
  });

  // Mutation caught: dropping min-w-0 from the label or the select (each keeps
  // its longest option's width), or dropping the 16 px phone text to fit.
  it('lets the label size shrink into the column and keeps its 16 px phone text', async () => {
    const dialog = await openDialog();
    const select = within(dialog).getByLabelText('Label size');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveClass('min-w-0', 'max-sm:text-base', 'max-sm:h-11', 'text-[13px]', 'h-8');
    expect(select.closest('label')).toHaveClass('flex', 'min-w-0');
    // The longest option is still offered whole in the list; a chosen long size
    // is cut inside the box.
    expect(
      within(select).getByRole('option', { name: 'Thermal roll · 50 × 80 mm (Phomemo large)' }),
    ).toBeInTheDocument();
  });

  // Mutation caught: dropping overflow-hidden. WebKit counted the cut words
  // of a long chosen size as overflow of the dialog, which then scrolled
  // sideways by 36 px at 390 px.
  it('clips a long chosen size inside the select', async () => {
    const dialog = await openDialog();
    const select = within(dialog).getByLabelText('Label size');
    fireEvent.change(select, { target: { value: 'thermal-50x80' } });
    expect(select).toHaveValue('thermal-50x80');
    expect(select).toHaveClass('overflow-hidden');
    // Its focus ring is a ring drawn outside the box, which the clip leaves whole.
    expect(select).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-offset-2');
  });
});
