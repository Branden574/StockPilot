# StockPilot — 3-minute Supabase setup

Run this once. After this, signup, dashboard, and inventory work end-to-end.

## 1. Create a Supabase project

1. Go to <https://supabase.com> and click **New project**
2. Pick any name (e.g. `stockpilot-dev`), a strong DB password, and a region near you
3. Wait ~1 min for it to provision

## 2. Apply the schema

1. Open your new project → left sidebar → **SQL Editor**
2. Click **+ New query**
3. Open `supabase/setup/full-schema.sql` from this repo, copy the entire file, paste it in
4. Click **Run** (bottom-right). Should take a few seconds. You'll see "Success. No rows returned."

This creates 25+ tables, RLS policies, triggers, and 6 RPC helper functions.

## 3. Configure storage buckets

1. Sidebar → **Storage** → **Create a new bucket**
2. Create four buckets with these names:
   - `item-images` — **Private**
   - `item-attachments` — **Private**
   - `org-logos` — **Public**
   - `po-imports` — **Private** (or skip — migration `0021_po_imports_bucket.sql`
     creates it programmatically)

(Storage RLS policies for these are set by `full-schema.sql` and migration
`0021_po_imports_bucket.sql`.)

## 4. Wire up your app

1. Sidebar → **Project Settings** → **API**
2. Copy:
   - **Project URL** → paste into `NEXT_PUBLIC_SUPABASE_URL`
   - **anon / public key** → paste into `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role secret key** → paste into `SUPABASE_SERVICE_ROLE_KEY` (server-only, never expose)

Update `apps/web/.env.local` with those values.

Restart your dev server:

```bash
pnpm dev
```

## 5. Configure Auth redirect URLs (for email confirmations)

Sidebar → **Authentication** → **URL Configuration**:

- **Site URL:** `http://localhost:3000`
- **Redirect URLs:** add `http://localhost:3000/auth/callback`

## 6. Sign up

Go to <http://localhost:3000/signup>. Real signup now works — confirmation email goes to the inbox you used (or check the **Auth → Users** tab to manually confirm if email isn't configured).

## What to do later

- For production: repeat steps 1–5 with a separate Supabase project (`stockpilot-prod`).
- For local-only dev with no internet: install [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker, then `supabase start`. The migrations in `supabase/migrations/` apply automatically.
