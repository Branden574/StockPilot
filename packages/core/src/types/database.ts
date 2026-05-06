/**
 * Supabase generated types are intentionally short-circuited to `any`.
 *
 * `pnpm db:types` (Supabase CLI) WILL successfully generate ~3900 lines
 * of accurate Row/Insert/Update types for every table. We've validated
 * that. But the codebase's services were authored against a loose
 * `Database = any` baseline and rely heavily on `as Record<string,
 * unknown>` and string-keyed access. Switching to strict generated
 * types causes ~50 type errors across services — not a real-bug
 * surface, just a typing-pattern mismatch.
 *
 * Refactoring the services to use typed Row/Insert/Update shapes is a
 * worthwhile follow-up (catches schema-shape drift at compile time)
 * but it's a multi-day pass — don't do it in the middle of a launch.
 *
 * When that refactor lands: regenerate via `pnpm db:types`, strip the
 * top-level `__InternalSupabase` metadata block (older
 * @supabase/supabase-js doesn't understand it — or upgrade the client),
 * delete this stub, and replace.
 */
export type Database = any;
