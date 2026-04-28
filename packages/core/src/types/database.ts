/**
 * Placeholder Supabase database type.
 *
 * Until you run `pnpm db:types` (which writes the canonical generated
 * types from your live schema), the codebase falls back to a permissive
 * `any` shape. That's deliberate: it lets the scaffold compile before
 * Supabase is initialized, without forcing you to maintain a hand-written
 * mirror of the SQL schema.
 *
 * To enable strong typing across all queries:
 *
 *   supabase start
 *   pnpm db:types
 *
 * That overwrites this file with the real generated types.
 */

// Json is exported for the rest of the codebase to use as-is.
export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

// `any` here intentionally widens Supabase's strict generic constraints so
// that `from('inventory_items').insert({ ... })` works without table-name
// narrowing. Real types come from `supabase gen types typescript`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;
