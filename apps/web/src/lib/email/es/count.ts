/**
 * A count and its noun: "1 unit", "2 units", "0 units", "1.5 units". The noun
 * is singular only for exactly one.
 *
 * The order emails printed every count with a plural noun, so an order of one
 * unit on one line read "Reserved 1 units across 1 lines". A sentence whose
 * verb or pronoun follows the count ("1 line is", "it's back in stock") picks
 * those by the same `n === 1` test where it is written.
 */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
