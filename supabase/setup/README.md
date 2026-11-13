# StockPilot database setup

The database schema comes from one place: the migrations in
[`supabase/migrations`](../migrations), applied in order. Every table, function,
trigger, access rule and storage policy is created there, and every later change
to one is a later migration.

There is no single-file copy of the schema. This folder used to hold one
(`full-schema.sql`); it was removed because it stopped at migration 0030 and so
had none of the changes made since, including later changes to access rules. Do
not build a database by pasting SQL from an old copy of it, and do not add a new
bundle: apply the migrations.

## A local database

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) and Docker.

```bash
supabase start      # boots local Postgres, Auth, Storage and Studio, and applies every migration
pnpm db:reset       # drops the local database and applies every migration again, then supabase/seed.sql
```

The storage buckets declared in `supabase/config.toml` are created by the local
stack. The rest of the local setup (the app's settings file, the dev server) is
in the root [`README.md`](../../README.md), under "Getting started".

## A new hosted project

1. Create an empty project at <https://supabase.com>.
2. Link this repository to it, then apply the migrations:

   ```bash
   supabase link --project-ref <project-ref>
   supabase db push    # applies, in order, every migration the project does not have yet
   ```

3. In the dashboard, under Storage, check that every bucket declared in
   `supabase/config.toml` exists, with the same visibility and limits. Create
   any that is missing.
4. Set the auth redirect URLs and the app's environment variables as
   [`DEPLOY.md`](../../DEPLOY.md) describes.

`supabase db push` is also how an existing project gets a new migration.
`supabase migration list` shows which migrations a linked project has.

## Signing in

Public sign-up is off: StockPilot is invite-only, and only a platform admin
creates a workspace. See "Creating a workspace" in the root
[`README.md`](../../README.md).
