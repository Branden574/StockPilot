# Deploying StockPilot to Vercel

This is a Turborepo monorepo with `apps/web` as the deployable Next.js app.
The Supabase backend is already provisioned and runs separately.

## 1. One-time Vercel project setup

Connect the repo at https://vercel.com/new and pick **the GitHub repo**, then:

| Setting | Value |
|---|---|
| Framework preset | Next.js (auto-detected) |
| **Root Directory** | `apps/web` |
| Build command | (leave default — it runs `next build`) |
| Install command | (leave default — Vercel runs `pnpm install` from repo root) |
| Output directory | (leave default) |
| Node version | 20.x (matches `.nvmrc` 20.11.0) |

Vercel auto-detects pnpm monorepos and hoists installs correctly. No `vercel.json` is required.

## 2. Environment variables

Set every variable from `apps/web/.env.example` in the Vercel project's **Settings → Environment Variables**. The required ones are:

```
NEXT_PUBLIC_APP_URL=https://your-vercel-domain.vercel.app
NEXT_PUBLIC_SITE_NAME=StockPilot
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from Supabase → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<from Supabase → Settings → API> # SECRET
```

Optional (only needed if you want those features live):

```
RESEND_API_KEY=...                 # transactional email; without it invites still work but emails are skipped
RESEND_FROM_EMAIL="StockPilot <hello@your-domain.com>"

# Stripe is not used in the internal-company build but the SDK is loaded;
# leave these blank in prod to keep the dead code dormant.
```

Set all of them for **Production**, **Preview**, and **Development** environments. The `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` should be marked as encrypted (Vercel does this automatically for non-`NEXT_PUBLIC_` keys).

## 3. Supabase auth redirect URLs

In Supabase → **Authentication → URL Configuration**, add:

```
Site URL:  https://your-vercel-domain.vercel.app
Redirect URLs:
  https://your-vercel-domain.vercel.app/auth/callback
  https://*.vercel.app/auth/callback   # for preview deploys
```

If you don't add the wildcard, magic-link sign-in on preview URLs will silently 401.

## 4. Database

The hosted Supabase project should already have migrations 0001–0008 applied. Verify with:

```sql
select count(*) from public.warehouse_charters;   -- should not error
select count(*) from public.user_warehouse_assignments where charter_id is not null;
```

If you ever need to start from scratch, `supabase/setup/full-schema.sql` is an idempotent bundle of every migration in order.

## 5. First deploy

```bash
git push origin main
```

Vercel auto-builds on every push to `main` (production) and every PR (preview). The build runs:

```
pnpm install --frozen-lockfile           # at repo root
cd apps/web && next build                # in the project subdir
```

Build target is ~8 seconds plus install time.

## 6. Post-deploy smoke test

1. Sign in as the owner.
2. Go to **Settings → Organization** and confirm "Charter / Warehouse" labels render.
3. **Admin → Charters** and **Admin → Warehouses** should both load with no errors.
4. Create a warehouse, link 2 charters to it.
5. Create an item — verify the warehouse + charter pickers work and "Generic" is an option.
6. **Team** → invite a manager and a warehouse-staff user. Confirm the warehouse-staff invite requires a warehouse.
7. As that staff user, confirm they cannot see items at other warehouses.

## 7. Notes for live testing with your manager

- Public sign-up is **disabled**. Your manager must accept an invite from `/dashboard/team`.
- The role pill at the bottom-left of the sidebar shows the user's UI label (Super Admin / Manager / Warehouse User / Read-Only Auditor).
- Managers see the warehouse filter dropdown in the topbar; warehouse-scoped users do not (it's a UX dead-end for them since their queries are forced).
- Stock transfer is on the item detail page; it appears once the org has 2+ locations.
- Audit log is at `/dashboard/admin/audit` (admin-only).
