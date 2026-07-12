// Shared PUBLIC catalog schema — the ONLY item shape that ships to
// anonymous visitors of /r/<token>. Defined here (types only, no runtime)
// so both the server loader (server/services/public-catalog.ts, which
// re-exports these) and the public-v2 client components consume the exact
// same schema without importing a 'server-only' module into the client
// bundle.
//
// It deliberately has NO field for cost, price, sku, rack/bin location,
// reserved quantities, reorder point, or charter data — leaking any of
// those is a compile error, not a remember-to-null-it convention.

export type PublicAvailability =
  /** availability_display='exact' — real net count (on hand − reserved). */
  | { kind: 'exact'; count: number }
  /** availability_display='bucket' — coarse bucket, no real numbers. */
  | { kind: 'bucket'; level: 'in_stock' | 'low_stock' | 'out_of_stock' }
  /** availability_display='none' — the link shows no stock signal at all. */
  | { kind: 'none' };

export interface PublicCatalogItem {
  id: string;
  /** public_display_name when set, else the internal name. */
  displayName: string;
  /** public_description when set; the internal description NEVER ships. */
  publicDescription: string | null;
  itemType: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  /**
   * Always null in the RSC payload — signed thumbnail URLs are fetched
   * after first paint by /api/v1/public/catalog-thumbnails (same deferred
   * pattern as the staff picker).
   */
  imageUrl: string | null;
  /** Tiny base64 blur (item_images.lqip) so cards never flash a bare box. */
  lqip: string | null;
  availability: PublicAvailability;
  /** Per-request qty cap: entry cap ?? link default ?? null (unlimited). */
  maxQty: number | null;
}

/** The link's availability display mode, echoed to the UI so the toolbar
 *  can decide whether to offer stock filters/sorts at all. */
export type PublicAvailabilityDisplay = 'exact' | 'bucket' | 'none';
