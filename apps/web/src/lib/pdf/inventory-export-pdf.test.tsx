import { describe, expect, it } from 'vitest';

import { getExportField, type InventoryExportFieldKey } from '@/lib/exports/field-registry';
import { computeExportPdfLayout } from '@/lib/exports/pdf-layout';
import type { InventoryExportSourceRow } from '@/lib/exports/source-row';

import {
  buildExportPdfRows,
  CATALOG_CARD_MIN_HEIGHT_PT,
  CATALOG_COVER_PT,
  EXPORT_PDF_EM_DASH,
  InventoryExportPdf,
} from './inventory-export-pdf';

/**
 * These assertions run over the ELEMENT TREE, not a rendered PDF. react-pdf's
 * output is a binary stream whose glyph positions are not readable from a unit
 * test, and the geometry itself is already pinned by pdf-layout.test.ts. What
 * this suite proves is that the document HANDS react-pdf the right structure:
 * the right page size, the right orientation, an image cell only when asked,
 * fixed header rows when repeat is on, a page-number renderer when it is on,
 * and no undefined/null leaking into a cell.
 */

const keys: InventoryExportFieldKey[] = [
  'image',
  'name',
  'isbn',
  'sku',
  'quantity_on_hand',
  'category',
  'status',
];
const fields = keys.map((k) => getExportField(k)!);

function makeSource(overrides: Partial<InventoryExportSourceRow> = {}): InventoryExportSourceRow {
  return {
    id: 'i-1',
    itemType: 'book',
    name: 'Introduction to Algorithms',
    sku: 'BK-0001',
    barcode: '9780262033848',
    status: 'active',
    quantityOnHand: 4,
    reorderPoint: 0,
    reorderQuantity: 0,
    unitCost: 42,
    retailPrice: 89,
    category: 'Mathematics',
    primaryLocation: 'DC4',
    supplier: '',
    warehouse: 'North',
    charter: 'Generic',
    trackingType: 'none',
    author: 'Cormen',
    isbn: '9780262033848',
    grade: 'College',
    rackNumber: '38',
    rackRow: 'A',
    crateColor: 'blue',
    crateNumber: '12',
    rackLabel: '38-A',
    crateLabel: 'Blue 12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    image: { thumbnailUrl: 'https://signed.example/a.webp' },
    // Required by InventoryExportSourceRow (source-row.ts); the brief's
    // fixture predates that field. legacy-only, unread by field-registry.ts /
    // buildExportPdfRows — any value satisfies the type.
    legacyRawBookFields: {
      grade: 'College',
      rackNumber: '38',
      rackRow: 'A',
      crateColor: 'blue',
      crateNumber: '12',
    },
    ...overrides,
  };
}

function makeLayout(overrides: Partial<Parameters<typeof computeExportPdfLayout>[0]> = {}) {
  return computeExportPdfLayout({
    fields,
    itemTypeKind: 'book',
    includeImages: true,
    imageSize: 'medium',
    orientation: 'auto',
    paperSize: 'letter',
    density: 'comfortable',
    wrapText: true,
    layout: 'table',
    catalogColumns: 2,
    ...overrides,
  });
}

/** Depth-first walk of a react element tree, yielding every element. */
function* walk(node: unknown): Generator<{ type: unknown; props: Record<string, unknown> }> {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== 'object') return;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return;
  yield { type: el.type, props: el.props };
  yield* walk(el.props.children);
}

function elementsOfType(tree: unknown, type: string) {
  return [...walk(tree)].filter((el) => el.type === type);
}

function textContent(tree: unknown): string[] {
  return elementsOfType(tree, 'TEXT')
    .map((el) => el.props.children)
    .filter((c): c is string => typeof c === 'string');
}

describe('buildExportPdfRows', () => {
  it('maps every selected field to a string cell, in order', () => {
    const rows = buildExportPdfRows([makeSource()], makeLayout(), fields, { showImages: true });
    expect(Object.keys(rows[0]!.cells)).toEqual([
      'name',
      'isbn',
      'sku',
      'quantity_on_hand',
      'category',
      'status',
    ]);
    expect(rows[0]!.cells.isbn).toBe('9780262033848');
    expect(rows[0]!.cells.quantity_on_hand).toBe('4');
  });

  it('renders a blank value as an em dash, never undefined or null', () => {
    const rows = buildExportPdfRows(
      [makeSource({ isbn: '', category: '' })],
      makeLayout(),
      fields,
      { showImages: true },
    );
    expect(rows[0]!.cells.isbn).toBe(EXPORT_PDF_EM_DASH);
    expect(rows[0]!.cells.category).toBe(EXPORT_PDF_EM_DASH);
    for (const value of Object.values(rows[0]!.cells)) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('undefined');
      expect(value).not.toBe('null');
      expect(value).not.toBe('[object Object]');
    }
  });

  it('renders a real zero as 0, not as an em dash', () => {
    const rows = buildExportPdfRows([makeSource({ quantityOnHand: 0 })], makeLayout(), fields, {
      showImages: true,
    });
    expect(rows[0]!.cells.quantity_on_hand).toBe('0');
  });

  it('carries the image URL only when images are on', () => {
    expect(
      buildExportPdfRows([makeSource()], makeLayout(), fields, { showImages: true })[0]!.imageUrl,
    ).toBe('https://signed.example/a.webp');
    expect(
      buildExportPdfRows([makeSource()], makeLayout(), fields, { showImages: false })[0]!.imageUrl,
    ).toBeNull();
  });

  it('renders an undefined value as an em dash', () => {
    const undefinedField = {
      ...fields[0]!,
      key: 'isbn' as const,
      value: () => undefined as unknown as string,
    };
    const customFields = [undefinedField];
    const rows = buildExportPdfRows([makeSource()], makeLayout(), customFields, {
      showImages: true,
    });
    expect(rows[0]!.cells.isbn).toBe(EXPORT_PDF_EM_DASH);
  });
});

describe('InventoryExportPdf — table mode', () => {
  const render = (overrides: Partial<Parameters<typeof InventoryExportPdf>[0]> = {}) => {
    const layout = makeLayout();
    return InventoryExportPdf({
      orgName: 'Demo Co',
      orgLogoUrl: null,
      title: 'Books export',
      subtitle: 'filtered - 111 books',
      layout,
      rows: buildExportPdfRows([makeSource()], layout, fields, { showImages: true }),
      repeatHeaders: true,
      pageNumbers: true,
      catalog: null,
      ...overrides,
    });
  };

  it('sets the page size and orientation the layout chose', () => {
    const page = elementsOfType(render(), 'PAGE')[0]!;
    expect(page.props.size).toEqual({ width: 792, height: 612 });
    expect(page.props.orientation).toBeUndefined();
  });

  it('renders every chosen column header, in the chosen order', () => {
    const texts = textContent(render());
    const headerOrder = ['TITLE', 'ISBN', 'SKU', 'ON HAND', 'CATEGORY', 'STATUS'];
    const found = texts.filter((t) => headerOrder.includes(t.toUpperCase()));
    expect(found.map((t) => t.toUpperCase())).toEqual(headerOrder);
  });

  it('marks the header row fixed so it repeats on every page', () => {
    const fixed = [...walk(render())].filter((el) => el.props.fixed === true);
    expect(fixed.length).toBeGreaterThan(0);
  });

  it('does NOT mark the header fixed when repeat headers is off', () => {
    const fixed = [...walk(render({ repeatHeaders: false }))].filter(
      (el) => el.props.fixed === true && el.type === 'VIEW',
    );
    expect(fixed).toHaveLength(0);
  });

  it('renders a page-number footer with a render function when page numbers are on', () => {
    const withNumbers = [...walk(render())].find(
      (el) => el.type === 'TEXT' && typeof el.props.render === 'function',
    );
    expect(withNumbers).toBeDefined();
    const rendered = (withNumbers!.props.render as (p: { pageNumber: number; totalPages: number }) => string)(
      { pageNumber: 1, totalPages: 8 },
    );
    expect(rendered).toBe('Page 1 of 8');
  });

  it('omits the page-number footer when page numbers are off', () => {
    const withNumbers = [...walk(render({ pageNumbers: false }))].find(
      (el) => el.type === 'TEXT' && typeof el.props.render === 'function',
    );
    expect(withNumbers).toBeUndefined();
  });

  it('draws the image with objectFit contain so a cover is never cropped', () => {
    const image = elementsOfType(render(), 'IMAGE').find(
      (el) => (el.props.src as string) === 'https://signed.example/a.webp',
    );
    expect(image).toBeDefined();
    // style is an array ([styles.thumb, {width, height}]), same pattern the
    // "grows the row" test below merges with Object.assign — react-pdf
    // flattens array styles at render time, so this is the box the image
    // actually draws into.
    const style = image!.props.style as Array<Record<string, unknown>>;
    const merged = Object.assign({}, ...style) as { objectFit?: string };
    expect(merged.objectFit).toBe('contain');
  });

  it('draws a placeholder, not a broken image, when a row has none', () => {
    const layout = makeLayout();
    const rows = buildExportPdfRows([makeSource({ image: null })], layout, fields, {
      showImages: true,
    });
    const tree = render({ layout, rows });
    expect(elementsOfType(tree, 'IMAGE')).toHaveLength(0);
    const placeholders = [...walk(tree)].filter(
      (el) => (el.props as { 'data-placeholder'?: boolean })['data-placeholder'] === true,
    );
    expect(placeholders).toHaveLength(1);
  });

  it('renders no image cell at all when images are off — no empty column', () => {
    const layout = makeLayout({ includeImages: false });
    const rows = buildExportPdfRows([makeSource()], layout, fields, { showImages: false });
    const tree = render({ layout, rows });
    expect(elementsOfType(tree, 'IMAGE')).toHaveLength(0);
    const placeholders = [...walk(tree)].filter(
      (el) => (el.props as { 'data-placeholder'?: boolean })['data-placeholder'] === true,
    );
    expect(placeholders).toHaveLength(0);
  });

  it('keeps each body row whole rather than splitting it across a page break', () => {
    const rowViews = [...walk(render())].filter(
      (el) => (el.props as { 'data-row'?: boolean })['data-row'] === true,
    );
    expect(rowViews.length).toBeGreaterThan(0);
    for (const row of rowViews) expect(row.props.wrap).toBe(false);
  });

  it('grows the row to the layout height when images are on', () => {
    const rowView = [...walk(render())].find(
      (el) => (el.props as { 'data-row'?: boolean })['data-row'] === true,
    )!;
    const style = rowView.props.style as Array<Record<string, unknown>>;
    const merged = Object.assign({}, ...style) as { minHeight?: number };
    expect(merged.minHeight).toBe(44);
  });

  it('renders portrait Legal when the layout says so', () => {
    const layout = makeLayout({ paperSize: 'legal', orientation: 'portrait' });
    const page = elementsOfType(render({ layout }), 'PAGE')[0]!;
    expect(page.props.size).toEqual({ width: 612, height: 1008 });
  });
});

describe('InventoryExportPdf — book catalog mode', () => {
  const catalogRender = (columns: 1 | 2 | 3, rowOverrides: Partial<InventoryExportSourceRow> = {}) => {
    const layout = computeExportPdfLayout({
      fields,
      itemTypeKind: 'book',
      includeImages: true,
      imageSize: 'large',
      orientation: 'auto',
      paperSize: 'letter',
      density: 'image-friendly',
      wrapText: true,
      layout: 'catalog',
      catalogColumns: columns,
    });
    const sources = [makeSource(rowOverrides), makeSource({ ...rowOverrides, id: 'i-2' })];
    return InventoryExportPdf({
      orgName: 'Demo Co',
      orgLogoUrl: null,
      title: 'Books catalog',
      subtitle: 'filtered - 2 books',
      layout,
      rows: buildExportPdfRows(sources, layout, fields, { showImages: true }),
      repeatHeaders: false,
      pageNumbers: true,
      catalog: { columns, fields, itemTypeKind: 'book' },
    });
  };

  it('renders one card per row, never a table header', () => {
    const tree = catalogRender(2);
    const cards = [...walk(tree)].filter(
      (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
    );
    expect(cards).toHaveLength(2);
    expect(textContent(tree)).not.toContain('ON HAND');
  });

  it('keeps every card whole rather than splitting it across a page', () => {
    const cards = [...walk(catalogRender(2))].filter(
      (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
    );
    for (const card of cards) expect(card.props.wrap).toBe(false);
  });

  it('shows the cover at the catalog size with objectFit contain', () => {
    const image = elementsOfType(catalogRender(2), 'IMAGE')[0]!;
    const style = Object.assign({}, ...(image.props.style as Array<Record<string, unknown>>)) as {
      objectFit?: string;
      width?: number;
      height?: number;
    };
    expect(style.objectFit).toBe('contain');
    expect(style.width).toBe(CATALOG_COVER_PT[2].widthPt);
    expect(style.height).toBe(CATALOG_COVER_PT[2].heightPt);
  });

  it('prints the ISBN clearly, labelled, inside each card', () => {
    const texts = textContent(catalogRender(2));
    expect(texts).toContain('ISBN');
    expect(texts).toContain('9780262033848');
  });

  it('uses a consistent placeholder for a book with no cover', () => {
    const tree = catalogRender(2, { image: null });
    const placeholders = [...walk(tree)].filter(
      (el) => (el.props as { 'data-placeholder'?: boolean })['data-placeholder'] === true,
    );
    expect(placeholders).toHaveLength(2);
    expect(elementsOfType(tree, 'IMAGE')).toHaveLength(0);
  });

  it('sizes each card to its share of the row for 1, 2 and 3 columns', () => {
    for (const columns of [1, 2, 3] as const) {
      const card = [...walk(catalogRender(columns))].find(
        (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
      )!;
      const style = Object.assign({}, ...(card.props.style as Array<Record<string, unknown>>)) as {
        width?: string;
      };
      expect(style.width).toBe(`${(100 / columns).toFixed(4)}%`);
    }
  });

  it('never prints undefined for a book missing every optional field', () => {
    const texts = textContent(
      catalogRender(2, { author: '', grade: '', rackLabel: '', crateLabel: '', isbn: '' }),
    );
    for (const t of texts) {
      expect(t).not.toContain('undefined');
      expect(t).not.toContain('null');
    }
  });

  it('pins both exported constants against literal numbers', () => {
    expect(CATALOG_COVER_PT).toEqual({
      1: { widthPt: 84, heightPt: 112 },
      2: { widthPt: 66, heightPt: 88 },
      3: { widthPt: 50, heightPt: 68 },
    });
    expect(CATALOG_CARD_MIN_HEIGHT_PT).toEqual({
      1: 132,
      2: 116,
      3: 96,
    });
  });

  it('renders the card minHeight style matching CATALOG_CARD_MIN_HEIGHT_PT for each column', () => {
    for (const columns of [1, 2, 3] as const) {
      const tree = catalogRender(columns);
      // Find the outer card wrapper with data-card
      const cardOuter = [...walk(tree)].find(
        (el) => (el.props as { 'data-card'?: boolean })['data-card'] === true,
      );
      expect(cardOuter).toBeDefined();
      // The inner card View is the first child (View element inside the cardOuter)
      // It carries the minHeight in its style array
      let innerCardFound = false;
      if (cardOuter?.props.children) {
        const children = cardOuter.props.children as unknown;
        if (Array.isArray(children)) {
          for (const child of children) {
            if (
              child &&
              typeof child === 'object' &&
              'type' in child &&
              'props' in child &&
              (child as { type?: unknown }).type === 'VIEW'
            ) {
              const style = (child as { props?: { style?: unknown } }).props?.style as
                | Array<Record<string, unknown>>
                | undefined;
              if (style && Array.isArray(style)) {
                const merged = Object.assign({}, ...style) as { minHeight?: number };
                if (merged.minHeight !== undefined) {
                  expect(merged.minHeight).toBe(CATALOG_CARD_MIN_HEIGHT_PT[columns]);
                  innerCardFound = true;
                  break;
                }
              }
            }
          }
        } else if (
          children &&
          typeof children === 'object' &&
          'type' in children &&
          'props' in children
        ) {
          const child = children as { type?: unknown; props?: { style?: unknown } };
          if (child.type === 'VIEW') {
            const style = child.props?.style as Array<Record<string, unknown>> | undefined;
            if (style && Array.isArray(style)) {
              const merged = Object.assign({}, ...style) as { minHeight?: number };
              if (merged.minHeight !== undefined) {
                expect(merged.minHeight).toBe(CATALOG_CARD_MIN_HEIGHT_PT[columns]);
                innerCardFound = true;
              }
            }
          }
        }
      }
      expect(innerCardFound).toBe(true);
    }
  });
});
