/**
 * Placeholder Supabase database type.
 *
 * Until you run one of the type-gen scripts (which write the canonical
 * generated types from your live schema), the codebase falls back to a
 * permissive `any` shape. That's deliberate: it lets the scaffold
 * compile before Supabase is initialized.
 *
 * To enable strong typing across all queries, pick whichever fits:
 *
 *   # Linked to your hosted project (most common — run `supabase login`
 *   # + `supabase link --project-ref <ref>` once first):
 *   pnpm db:types
 *
 *   # Local Supabase running via `supabase start`:
 *   pnpm db:types:local
 *
 *   # CI / one-off without a linked config:
 *   SUPABASE_PROJECT_ID=<ref> pnpm db:types:remote
 *
 * Any of those overwrites this file with the real generated types.
 */

// Json is exported for the rest of the codebase to use as-is.
export type Json = string | number | boolean | null | { [k: string]: Json | undefined } | Json[];

// `any` here intentionally widens Supabase's strict generic constraints so
// that `from('inventory_items').insert({ ... })` works without table-name
// narrowing. Real types come from `supabase gen types typescript`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;
