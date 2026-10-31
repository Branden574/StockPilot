import { inflateSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import {
  countInPdf,
  embeddedJpeg,
  isWhite,
  rgbAt,
  seeThroughImage,
  STORAGE_PHOTO_URL,
  withStoragePhoto,
} from '@/test/see-through-images';

import { prefetchImagesAsDataUris } from './image-prefetch';
import { renderCustomerPackingSlipPdf } from './packing-slip-customer';
import { renderWarehousePackingSlipPdf } from './packing-slip-warehouse';

// The photo goes through the real image prefetch, whose data-URI cache needs a
// Next request scope; here it calls straight through. The slips do not use
// next/cache, so the other tests are unaffected.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

/**
 * Every text run in a @react-pdf document lands in a FlateDecode content
 * stream, and each run is drawn as hex-string glyph codes (`[<53>…] TJ` /
 * `<5369…> Tj`), so raw bytes never contain the strings the page draws.
 * Inflate every stream…endstream section that decompresses cleanly, then
 * decode every hex string back to characters. These slips use Helvetica (a
 * standard-14 font, WinAnsi-encoded), so the glyph codes ARE the character
 * codes and the result reads as the page's visible text in draw order.
 */
function extractPdfText(pdf: Buffer): string {
  const streams: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = pdf.indexOf('stream', cursor);
    if (start === -1) break;
    // Skip the keyword + the EOL that follows it (\r\n or \n per spec).
    let dataStart = start + 'stream'.length;
    if (pdf[dataStart] === 0x0d) dataStart += 1;
    if (pdf[dataStart] === 0x0a) dataStart += 1;
    const end = pdf.indexOf('endstream', dataStart);
    if (end === -1) break;
    try {
      streams.push(inflateSync(pdf.subarray(dataStart, end)).toString('latin1'));
    } catch {
      // Not a flate stream (font file, image, …) — skip it.
    }
    cursor = end + 'endstream'.length;
  }
  return (streams.join('\n').match(/<[0-9a-fA-F]+>/g) ?? [])
    .map((h) =>
      (h.slice(1, -1).match(/.{2}/g) ?? [])
        .map((b) => String.fromCharCode(parseInt(b, 16)))
        .join(''),
    )
    .join('');
}

const DIGITAL_SIGNATURE_LABEL = 'Signature captured digitally in StockPilot';

const baseInput = {
  detail: {
    request: {
      id: '0000000f-0000-4000-8000-000000000001',
      order_number: 14,
      organization_id: 'org-1',
      warehouse_id: 'wh-1',
      requester_user_id: null,
      requester_email: 'carsten.fowler@school.test',
      requester_name: 'Lena Hale',
      requester_org_label: 'Clovis',
      source: 'internal' as const,
      status: 'packing_slip_generated' as const,
      notes: 'Delivery for Lena Hale to Clovis',
      internal_notes: null,
      requester_phone: null,
      delivery_charter_id: null,
      pickup_location_notes: null,
      fulfillment_type: 'delivery' as const,
      assigned_picker_id: null,
      packing_slip_generated_at: '2026-05-20T18:00:00.000Z',
      delivered_at: null,
      cancelled_at: null,
      created_at: '2026-05-20T00:00:00.000Z',
      updated_at: '2026-05-20T00:00:00.000Z',
      approved_at: null,
      signature_token: null,
      signature_token_expires_at: null,
      signed_by_name: null,
      signed_by_email: null,
      signature_data_url: null,
      signed_at: null,
      completed_at: null,
      completed_by: null,
    },
    warehouseName: 'DC4',
    requesterDisplay: 'Lena Hale',
    requesterName: 'Lena Hale',
    requesterEmail: 'carsten.fowler@school.test',
    reservations: [],
    lines: [
      {
        id: 'L1',
        order_request_id: '0000000f',
        item_id: 'i1',
        quantity_requested: 30,
        quantity_fulfilled: 0,
        quantity_picked: 30,
        unit_cost_at_request: 0,
        notes: null,
        item: {
          id: 'i1',
          name: 'Google Chrome Book',
          sku: 'SP-BVK31-LH9',
          quantity_on_hand: 50,
          barcode: null,
          model_number: 'Lenovo 100e Gen 4',
          item_type: 'product',
          custom_fields: { rack_number: '2', rack_row: 'A' },
        },
      },
    ],
  },
  warehouse: {
    name: 'DC4',
    code: 'DC4',
    address: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
  },
  charterName: null,
  imageUrlByItemId: new Map<string, string>(),
  qrDataUrl: null,
  orgTimezone: 'UTC',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('renderWarehousePackingSlipPdf', () => {
  it('renders a non-empty PDF buffer without a holdings map (label fallback)', async () => {
    const buf = await renderWarehousePackingSlipPdf(baseInput);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(2000);
    // PDF files always start with the magic header %PDF
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  }, 30000);

  it('renders when the caller passes a split-item holdings map', async () => {
    const rackHoldingsByItemId = new Map([
      [
        'i1',
        [
          { name: '2-C', quantity: 20 },
          { name: '5-A', quantity: 5 },
        ],
      ],
    ]);
    const buf = await renderWarehousePackingSlipPdf({
      ...baseInput,
      rackHoldingsByItemId,
    });
    expect(buf.byteLength).toBeGreaterThan(2000);
  }, 30000);

  it('prints the signed-digitally checkbox label in the signature block', async () => {
    const buf = await renderWarehousePackingSlipPdf(baseInput);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    const text = extractPdfText(buf);
    expect(text).toContain(DIGITAL_SIGNATURE_LABEL);
    // The row belongs to the manual signature block — pin the ordering so a
    // refactor can't drift it above the ink lines it annotates.
    expect(text.indexOf(DIGITAL_SIGNATURE_LABEL)).toBeGreaterThan(text.indexOf('DATE / TIME'));
  }, 30000);

  it("does NOT print the checkbox label on the customer slip — its signature semantics are the customer's own", async () => {
    const buf = await renderCustomerPackingSlipPdf(baseInput);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    // Sanity: the extractor works on this document too (shared brand band)…
    expect(extractPdfText(buf)).toContain('PACKING SLIP');
    // …so the label's absence is a real absence, not a broken extractor.
    expect(extractPdfText(buf)).not.toContain(DIGITAL_SIGNATURE_LABEL);
  }, 30000);
});

/**
 * B62: these slips printed a see-through WebP photo on a black square (a
 * black item vanished on it). The photo goes from storage through the image
 * prefetch both slip routes use; it now prints as a JPEG on white. The
 * customer slip shares the line table, and it goes in the box.
 */
describe('a see-through photo on the packing slips (B62)', () => {
  it.each([
    ['warehouse', renderWarehousePackingSlipPdf],
    ['customer', renderCustomerPackingSlipPdf],
  ] as const)(
    'the %s slip prints a WebP as one JPEG on white, with no soft mask',
    async (_slip, render) => {
      const pdf = await withStoragePhoto(await seeThroughImage('webp-lossy'), async () => {
        const uris = await prefetchImagesAsDataUris([['i1', STORAGE_PHOTO_URL] as const]);
        expect(uris.get('i1')).toMatch(/^data:image\/jpeg;base64,/);
        return render({ ...baseInput, imageUrlByItemId: new Map([['i1', uris.get('i1')!]]) });
      });
      expect(countInPdf(pdf, '/DCTDecode')).toBe(1);
      expect(countInPdf(pdf, '/SMask')).toBe(0);
      const corner = await rgbAt(embeddedJpeg(pdf), 0, 0);
      expect(isWhite(corner), `corner of the printed photo: ${corner.join(',')}`).toBe(true);
    },
    30000,
  );
});
