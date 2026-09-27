/**
 * Which placeholder glyph an Items list row shows when it has no photo.
 *
 * Owner report 2026-09-27: an electronics item, a Chromebook, read as a book.
 * This list picked the book glyph for any category whose NAME contained the
 * letters "book", so a "Chromebooks" or "Macbook accessories" category wore
 * the same icon as the Books section.
 *
 * The Books feature everywhere else in StockPilot is `item_type = 'book'`
 * (packages/core/src/inventory/list-visibility.ts, the Books tab, book racks
 * and crates). That is the first rule here. A category name still earns the
 * book glyph, but only when "book" or "books" is a whole word in it ("Books",
 * "Library books"), never when it is part of another word.
 *
 * Kept free of lucide-react-native so the node test environment can load it;
 * the screen maps each kind to its icon.
 */

export type ItemListGlyph = 'book' | 'equipment' | 'supplies' | 'generic';

/** "book" or "books" as a word of its own: "Library books", not "Chromebooks". */
const BOOK_WORD = /\bbooks?\b/i;

export function itemListGlyph(item: {
  item_type?: string | null;
  category_name?: string | null;
}): ItemListGlyph {
  if (item.item_type === 'book') return 'book';
  const category = item.category_name ?? '';
  if (BOOK_WORD.test(category)) return 'book';
  const cat = category.toLowerCase();
  if (cat.includes('equipment')) return 'equipment';
  if (cat.includes('supply') || cat.includes('supplies')) return 'supplies';
  return 'generic';
}
