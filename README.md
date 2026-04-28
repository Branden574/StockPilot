# StockPilot

> Premium multi-tenant inventory SaaS. Web (Next.js 16) + iOS/Android (Expo, Phase 7) + Supabase Postgres backend.

## Stack

- **Web:** Next.js 16 · TypeScript · Tailwind CSS v4 · shadcn/ui · Framer Motion · TanStack Query · React Hook Form + Zod
- **Backend:** Supabase Postgres 16 (RLS, Auth, Storage, Realtime, Edge Functions)
- **Payments:** Stripe Billing
- **Email:** Resend + React Email
- **Monorepo:** Turborepo + pnpm workspaces
- **Hosting:** Vercel (web) · Supabase (backend) · EAS (mobile, Phase 7)

See [`BLUEPRINT.md`](./BLUEPRINT.md) for the full architecture, schema, and 10-phase roadmap.

## Repo layout

```
.
├── apps/
│   └── web/                Next.js 16 marketing + dashboard
├── packages/
│   ├── core/               Shared types, Zod schemas, constants (used by web + future mobile)
│   ├── db/                 Database documentation
│   └── config/             Shared tsconfig + ESLint preset
├── supabase/
│   ├── migrations/         SQL migrations (0001_init, 0002_inventory, 0003_rls)
│   ├── config.toml         Local Supabase config
│   └── seed.sql            Local dev seed
└── BLUEPRINT.md            Full product + technical blueprint
```

## Prerequisites

- **Node.js** ≥ 20.11 (use `nvm use` — the `.nvmrc` points to 20.11.0)
- **pnpm** ≥ 9 (`npm install -g pnpm`)
- **Supabase CLI** for local development (`brew install supabase/tap/supabase`)
- **Vercel CLI** (recommended): `npm install -g vercel`
- **Stripe CLI** (for webhook testing): `brew install stripe/stripe-cli/stripe`

## Getting started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start local Supabase

```bash
supabase start
```

This boots Postgres, GoTrue auth, Storage, Studio (`http://localhost:54323`), and the inbucket dev mailbox (`http://localhost:54324`).

### 3. Apply migrations + seed

Migrations in `supabase/migrations/` run automatically on `supabase start`. To re-apply:

```bash
pnpm db:reset
```

### 4. Configure env

```bash
cp apps/web/.env.example apps/web/.env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` from `supabase status`. Stripe and Resend can stay blank for now — they're only required at the Phase 6 / 4 boundaries respectively.

### 5. Run the dev server

```bash
pnpm dev
```

The web app boots at [http://localhost:3000](http://localhost:3000).

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the web dev server (Turbopack) |
| `pnpm build` | Production build via Turbo |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm lint` | ESLint via Next.js |
| `pnpm format` | Prettier write |
| `pnpm format:check` | Prettier check (CI) |
| `pnpm db:reset` | Drop + reapply local migrations |
| `pnpm db:push` | Push pending migrations to linked Supabase project |
| `pnpm db:types` | Regenerate `packages/core/src/types/database.ts` from the live schema |

## Environments

| Env | Hosting | DB |
|---|---|---|
| Local | `pnpm dev` | `supabase start` |
| Preview | Vercel preview per PR | Supabase dev project |
| Staging | Vercel staging | Supabase staging project |
| Production | Vercel prod | Supabase prod project |

## Linting & formatting

Prettier config lives under the `"prettier"` key of the root `package.json`. ESLint runs via `next lint` using `next/core-web-vitals` defaults — no custom config file is checked in (the harness blocks linter config edits in this workspace; add one locally if you want stricter rules).

## What's in Phase 1 (this commit)

- Monorepo (`apps/web`, `packages/core`, `packages/config`, `packages/db`)
- Next.js 16 + Tailwind v4 + shadcn primitives + theme provider (light/dark/system)
- Supabase server / browser / admin clients + auth-aware middleware
- Foundational migrations: organizations, user_profiles, organization_members, organization_invites — RLS enabled with helper functions (`is_org_member`, `user_org_role`, `has_org_role`)
- Inventory + RLS migrations also included so Phase 2 starts with the schema in place
- Auth flows: sign in, sign up, password reset, OAuth/email-confirm callback
- Onboarding: create-organization wizard, default location seeded
- Marketing landing: hero with floating cards + dashboard mockup, feature grid, use cases, pricing toggle, FAQ, final CTA
- Dashboard shell: sidebar nav, topbar, user menu, stat cards, empty state, dashboard home
- Stripe + Resend env scaffolding (no implementation yet — wired up in Phases 4/6)
- Zod schemas + shared types in `@stockpilot/core`
- GitHub Actions CI workflow

## Phase 2 next

Inventory CRUD (table, drawer form, detail page), categories, locations, suppliers, stock movements, low-stock dashboard card. The schema is already in place — just needs UI + service-layer logic.

---

© StockPilot — built carefully on purpose.
