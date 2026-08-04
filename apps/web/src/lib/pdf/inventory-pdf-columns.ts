import type { ReportColumn } from './report-table';

/**
 * Curated PDF column sets for the inventory export.
 *
 * A PDF cannot carry the full 25-column CSV dump legibly, so it has always used
 * a hand-picked subset — but the subset lived inline in the route and applied
 * to books and items alike, which is how the Books PDF shipped with no ISBN
 * even though every row object already carried one (Audit BUG 2).
 *
 * Every column now declares a point minimum. Without one, a low-weight column
 * gets squeezed until its header touches its neighbour, which is what printed
 * "ON HANDCATEGORY" (Audit BUG 1). The minimums are the widest realistic
 * header/content each column must show at 8pt bold / 8.5pt regular, and
 * report-table-fit.test.ts holds them to it.
 *
 * PHASE NOTE: this file is the Phase A repair. Phase C replaces it with columns
 * derived from the field registry and the user's chosen field order; keep the
 * widths, they are the tuned starting point the registry inherits.
 */

/** Books: Title, SKU, ISBN first — the three ways a book is identified. */
export const BOOKS_PDF_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Title', width: 3, minWidth: 90 },
  { key: 'sku', label: 'SKU', width: 1.4, minWidth: 52, wrap: false },
  // ISBN is fixed and readable and must NEVER be truncated (Brief section
  // 11). VALUE-based derivation, not a header-width guess: the widest
  // realistic ISBN is NOT the plain 13-digit string — `inventory_items.barcode`
  // (which doubles as the book ISBN) has no digit-only guard anywhere a human
  // can type it (packages/core/src/schemas/inventory.ts's Zod schema is
  // `z.string().max(128).trim()`, no regex; item-form.tsx's ISBN input has no
  // onChange stripping). Only the automated paths — barcode scanner, Google
  // Books lookup, bulk book import — normalize hyphens out. A person typing
  // the ISBN straight off a book's back cover, "978-1-234-56789-7" (the
  // standard 5-group ISBN-13 hyphenation, 13 digits + 4 hyphens = 17 chars),
  // saves it verbatim. That value measures 72.76pt at REPORT_BODY_FONT_SIZE_PT
  // (8.5pt Helvetica; report-table.tsx's reportStyles.cell) — wider than the
  // 61.44pt an unhyphenated 13-digit string would need. Floor derivation:
  //   minWidth = ceil(72.76 + 2*REPORT_CELL_PADDING_PT + 2)   // 2*3pt gutter + 2pt safety
  //            = ceil(72.76 + 6 + 2) = ceil(80.76) = 81
  { key: 'isbn', label: 'ISBN', width: 1.6, minWidth: 81, wrap: false },
  { key: 'author', label: 'Author', width: 1.6, minWidth: 62 },
  // FIX-WAVE (Task 4 review, finding 3): 38 was an unexplained drift from
  // field-registry.ts's grade.pdfMinWidth (40) — Task 2's own fix-wave had
  // already flagged this exact column's margin as thin (1.11pt, eroded from
  // 2.40pt by the isbn-width fix). Re-derived from the header alone, same
  // formula as isbn/quantity_on_hand:
  //   headerWidth('Grade') = width('GRADE', Helvetica-Bold, 8pt)
  //                            + 5*REPORT_HEADER_LETTER_SPACING_PT
  //                         = 28.888 + 2.0 = 30.888
  //   minWidth = ceil(30.888 + 2*REPORT_CELL_PADDING_PT + 2)
  //            = ceil(30.888 + 6 + 2) = ceil(38.888) = 39
  // 39 raises the real margin here to 2.11pt (was 1.11pt) and matches
  // field-registry.ts's grade.pdfMinWidth, which is now also 39.
  { key: 'grade', label: 'Grade', width: 0.8, minWidth: 39 },
  // FIX-WAVE (Controller rider on Task 1's re-review): the exhaustive sweep
  // this rider requires found "On hand" overflowing its own header box here
  // by -1.82pt once fed through the real allocator at this section's actual
  // column set (a 10-column Books row leaves less surplus per column than the
  // 7-column set the brief's minWidth:44 was eyeballed against). Derived
  // exactly as Task 1's fix-wave did:
  //   minWidth = ceil(headerWidth('On hand') + 2*REPORT_CELL_PADDING_PT + 2)
  //            = ceil(40.13 + 6 + 2) = ceil(48.13) = 49
  // matching the same 49pt floor report-configs.ts already uses for this
  // exact label in dead-stock/reorder-forecast/velocity-class.
  { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9, minWidth: 49, maxWidth: 70 },
  { key: 'category', label: 'Category', width: 1.4, minWidth: 58 },
  { key: 'primary_location', label: 'Location', width: 1.4, minWidth: 58 },
  { key: 'charter', label: 'Charter', width: 1.2, minWidth: 52 },
  { key: 'status', label: 'Status', width: 1, minWidth: 46 },
];

/** Items: the pre-existing set, now with minimums and no book-only fields. */
export const ITEMS_PDF_COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Name', width: 3, minWidth: 90 },
  { key: 'sku', label: 'SKU', width: 1.4, minWidth: 52, wrap: false },
  { key: 'quantity_on_hand', label: 'On hand', align: 'right', width: 0.9, minWidth: 44, maxWidth: 70 },
  { key: 'category', label: 'Category', width: 1.4, minWidth: 58 },
  { key: 'primary_location', label: 'Location', width: 1.4, minWidth: 58 },
  { key: 'charter', label: 'Charter', width: 1.4, minWidth: 52 },
  { key: 'status', label: 'Status', width: 1, minWidth: 46 },
];
