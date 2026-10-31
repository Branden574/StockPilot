/**
 * Is this value a uuid? The one check for a record id that comes from
 * outside the app: a link's path, a query value, a scanned code. The web
 * checks every record page's and route's path id with it before anything is
 * read (B63), and the phone's Book Order Totals report checks its ids with it.
 *
 * Any 8-4-4-4-12 group of hex digits, in any case and with any version
 * nibble, as Postgres accepts a uuid. The seed and the test fixtures use ids
 * no RFC version allows (00000000-0000-0000-0000-000000000001,
 * aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee), so this is a plain pattern on
 * purpose, not zod's uuid(): zod 4 checks the version and variant bits (C12)
 * and would refuse them.
 *
 * Stricter than Postgres only for spellings the app never makes: braces, 32
 * digits with no hyphens, or hyphens after other groups of four. The value is
 * never rewritten (an upper-case id stays upper case).
 *
 * Pure: no I/O, no platform API.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
