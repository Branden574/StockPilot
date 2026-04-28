# @stockpilot/db

Source of truth for the Supabase Postgres schema.

## Migrations

Migrations are numbered SQL files in `supabase/migrations/` (mirrored at the repo root for the Supabase CLI). Run them with:

```bash
pnpm db:reset      # drop + re-apply all migrations against local Supabase
pnpm db:push       # push pending migrations to the linked project
pnpm db:types      # regenerate packages/core/src/types/database.ts
```

## Files

| File | Purpose |
|---|---|
| `0001_init.sql` | Extensions, helper functions, identity tables (orgs, profiles, members, invites) |
| `0002_inventory.sql` | Inventory taxonomy + items + movements + POs |
| `0003_rls.sql` | Row-level security policies for every tenant table |
| `0004_triggers.sql` | Search vectors, updated_at, denormalization |
| `seed.sql` | Local development seed data |

## Conventions

- Every tenant table includes `organization_id uuid not null`.
- Every mutable table includes `created_at`, `updated_at`, and (where relevant) `created_by`, `updated_by`.
- Soft delete via `deleted_at timestamptz` on inventory_items, locations, suppliers, categories.
- All FKs have explicit `on delete` behavior.
- Indexes: at least one composite on `(organization_id, ...)` per tenant table.
- RLS: enabled with at least four policies (select / insert / update / delete) per tenant table.
