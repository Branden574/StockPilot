/**
 * Made-up Items and Books list rows, shaped like what the list pages hand the
 * table: InventoryListItemRow after image resolution (resolveInventoryListImages),
 * the placement lines and the 14-day trends. Used to weigh the page payload
 * (inventory-client-payload.size.test.ts) and to check that the rows the
 * client receives still filter, sort, search and total the same.
 *
 * Every value is invented. Lengths are modelled on what the real columns hold:
 *   - a signed storage URL is about 490 characters (host, bucket path with
 *     three uuids, then a signed query string of about 290);
 *   - an LQIP is a 16x16 WebP data URL of about 270 characters;
 *   - a book's custom_fields carries what the ISBN imports write (author,
 *     publisher, published date, page count, a cover URL, often a long
 *     description) next to the rack, crate and grade keys the list reads.
 *
 * Profiles:
 *   - 'seeded': the local load test's rows (no photos, empty custom_fields,
 *     no description, one Unplaced holding each, an opening movement in the
 *     trend window). This is the 1,000-item load test that measured the
 *     Items page at about 720 KB.
 *   - 'items': a typical Items view (most rows photographed, rack keys and a
 *     few org custom fields, some descriptions, one or two holdings).
 *   - 'books': a typical Books view (covers, imported book metadata).
 */

import type { InventoryListItemRow, InventoryPlacementLine } from '@/server/loaders/inventory-list';

export type PayloadProfile = 'seeded' | 'items' | 'books';

export interface SyntheticListView {
  items: InventoryListItemRow[];
  placement: Record<string, InventoryPlacementLine[]>;
  trends: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
}

const ORG = '0f000000-0000-4000-8000-0000000000aa';
const WAREHOUSES = ['0e000000-0000-4000-8000-0000000000a1', '0e000000-0000-4000-8000-0000000000a2'];
const CATEGORIES = Array.from(
  { length: 8 },
  (_, i) => `0d000000-0000-4000-8000-0000000000${String(10 + i)}`,
);
const CHARTERS = ['0c000000-0000-4000-8000-0000000000c1', '0c000000-0000-4000-8000-0000000000c2'];
const USER = '0b000000-0000-4000-8000-0000000000b1';
const RACK_LOCATIONS = Array.from(
  { length: 40 },
  (_, i) => `0a000000-0000-4000-8000-${String(100000000000 + i)}`,
);
const UNPLACED_LOCATION = '0a000000-0000-4000-8000-0000000000f1';

const ADJECTIVES = ['Blue', 'Large', 'Steel', 'Classic', 'Compact', 'Heavy', 'Soft', 'Bright'];
const NOUNS = ['Binder', 'Chromebook', 'Marker Set', 'Tee', 'Stapler', 'Cable', 'Notebook', 'Lamp'];

/** A uuid that is unique per (prefix, n). */
function uuid(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function timestamp(minutesAgo: number): string {
  const d = new Date(Date.UTC(2026, 10, 1, 12, 0, 0) - minutesAgo * 60_000);
  return `${d.toISOString().slice(0, 19)}.${String(123456 + minutesAgo).slice(-6)}+00:00`;
}

/** A signed-URL-length string for a storage object (made up). */
function signedUrl(itemId: string, n: number, variant: 'thumb' | 'master'): string {
  const objectPath = `item-images/${ORG}/${itemId}/${uuid('1a000000', n)}${variant === 'thumb' ? '_thumb' : ''}.webp`;
  return `https://exampleprojectref00.supabase.co/storage/v1/object/sign/${objectPath}?sig=${'a'.repeat(290)}`;
}

function lqip(): string {
  return `data:image/webp;base64,${'U'.repeat(248)}`;
}

function description(n: number, long: boolean): string {
  const sentence = `A made-up description for record ${n}, written to stand in for the text a catalogue entry carries. `;
  return sentence.repeat(long ? 9 : 1).trim();
}

function trendFor(qty: number, n: number): { qtySeries: number[]; moveSeries: number[] } {
  // Most records moved once in the window (the opening movement or a later
  // adjustment); a few did not move at all.
  const qtySeries = new Array<number>(14).fill(qty);
  const moveSeries = new Array<number>(14).fill(0);
  if (n % 9 !== 0) {
    const day = n % 14;
    for (let d = 0; d < day; d++) qtySeries[d] = Math.max(0, qty - 5);
    moveSeries[day] = 1;
  }
  return { qtySeries, moveSeries };
}

/** One synthetic view of `n` rows. Deterministic for a given (n, profile). */
export function syntheticListView(n: number, profile: PayloadProfile): SyntheticListView {
  const items: InventoryListItemRow[] = [];
  const placement: Record<string, InventoryPlacementLine[]> = {};
  const trends = new Map<string, { qtySeries: number[]; moveSeries: number[] }>();
  const book = profile === 'books';
  for (let g = 1; g <= n; g++) {
    const id = uuid('0f0f0f0f', g);
    const qty = g % 13 === 0 ? 0 : g % 7 === 0 ? 2 + (g % 6) : 40 + ((g * 37) % 460);
    const reorder = g % 5 === 0 ? 10 + (g % 20) : 0;
    const warehouseId = WAREHOUSES[g % 10 < 7 ? 0 : 1]!;
    const photographed = profile !== 'seeded' && g % 5 !== 0;
    const rackIdx = g % RACK_LOCATIONS.length;
    const rackNumber = String(1 + (rackIdx % 20));
    const rackRow = 'ABCD'[rackIdx % 4]!;

    let customFields: Record<string, unknown> = {};
    if (profile === 'items') {
      customFields = { rack_number: rackNumber, rack_row: rackRow };
      if (g % 3 === 0) customFields.size = ['S', 'M', 'L', 'XL'][g % 4];
      if (g % 4 === 0) customFields.color = 'Navy';
      if (g % 6 === 0) customFields.material = 'Cotton blend';
    } else if (book) {
      customFields = {
        author: `Author ${g % 300}, Second Author ${g % 7}`,
        publisher: `Example Press ${g % 40}`,
        published_date: `20${String(10 + (g % 15))}-0${1 + (g % 9)}-15`,
        page_count: 120 + (g % 400),
        thumbnail_url: `https://books.example.com/books/content?id=EXAMPLE${String(g).padStart(6, '0')}&printsec=frontcover&img=1&zoom=1&source=gbs_api`,
        book_rack_number: rackNumber,
        book_rack_row: rackRow,
        book_grade: String(1 + (g % 12)),
      };
      if (g % 3 === 0) {
        customFields.book_crate_color = 'blue';
        customFields.book_crate_number = String(1 + (g % 30));
      }
      // The bulk ISBN import keeps the catalogue description here.
      if (g % 2 === 0) customFields.description = description(g, true);
    }

    const placedHere = profile !== 'seeded' && g % 4 !== 0;
    const lines: InventoryPlacementLine[] = placedHere
      ? [
          {
            locationId: RACK_LOCATIONS[rackIdx]!,
            label: `${rackNumber}-${rackRow}`,
            kind: 'rack',
            quantity: g % 8 === 0 ? Math.max(1, qty - 3) : qty,
          },
          ...(g % 8 === 0 && qty > 3
            ? [{ locationId: UNPLACED_LOCATION, label: 'Unplaced', kind: 'unplaced', quantity: 3 }]
            : []),
        ]
      : qty > 0
        ? [{ locationId: UNPLACED_LOCATION, label: 'Unplaced', kind: 'unplaced', quantity: qty }]
        : [];
    if (lines.length > 0) placement[id] = lines;
    const unplaced = lines.filter((l) => l.kind === 'unplaced').reduce((s, l) => s + l.quantity, 0);
    const racks = lines.filter((l) => l.kind === 'rack');

    const name = book
      ? `The Made-Up Title Number ${g}: A Second Line Subtitle`
      : `${ADJECTIVES[g % ADJECTIVES.length]} ${NOUNS[Math.floor(g / ADJECTIVES.length) % NOUNS.length]} ${g % 97}`;
    items.push({
      id,
      sku: book
        ? `978${String(1000000000 + g)}`
        : `LT-W${(g % 2) + 1}-${String(g).padStart(6, '0')}`,
      barcode: book ? `978${String(1000000000 + g)}` : `LTB${String(g).padStart(9, '0')}`,
      model_number: profile === 'items' && g % 3 === 0 ? `MDL-${g}` : null,
      name,
      description: profile === 'items' && g % 2 === 0 ? description(g, false) : null,
      status: g % 50 === 0 ? 'archived' : 'active',
      quantity_on_hand: qty,
      reorder_point: reorder,
      unit_cost: Math.round((1 + ((g * 7919) % 5000) / 100) * 100) / 100,
      retail_price: Math.round((2 + ((g * 7919) % 9000) / 100) * 100) / 100,
      category_id: CATEGORIES[g % CATEGORIES.length]!,
      supplier_id: profile === 'seeded' ? null : uuid('0b0b0b0b', 1 + (g % 12)),
      primary_location_id: null,
      warehouse_id: warehouseId,
      charter_id: g % 3 === 0 ? CHARTERS[g % 2]! : null,
      tracking_type: 'none',
      item_type: book ? 'book' : 'product',
      auto_archived: false,
      awaiting_first_receipt: false,
      custom_fields: customFields,
      group_id: null,
      variant_size: null,
      variant_size_system: null,
      jersey_number: null,
      variant_key: null,
      created_at: timestamp(10_000 + g),
      updated_at: timestamp(g),
      staged_quantity: 0,
      unplaced_quantity: unplaced,
      placed_quantity: Math.max(0, qty - unplaced),
      placed_racks: racks.map((l) => l.label),
      rackHoldingsCount: racks.length,
      placed_holdings: racks.map((l) => ({ name: l.label, quantity: l.quantity, kind: 'rack' })),
      display_group_id: null,
      display_group_name: null,
      display_group_version: null,
      // Items ride the payload diet (thumb only); Books keep master, thumb and LQIP.
      image_url: photographed && book ? signedUrl(id, g, 'master') : null,
      image_thumb_url: photographed ? signedUrl(id, g, 'thumb') : null,
      image_lqip: photographed && book ? lqip() : null,
      // Columns the loaders select that the row type does not name.
      ...({ is_rental: false, created_by: USER, updated_by: USER } as object),
    } as InventoryListItemRow);
    trends.set(id, trendFor(qty, g));
  }
  return { items, placement, trends };
}
