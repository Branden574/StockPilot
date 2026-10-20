import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
