# StockPilot

> Internal warehouse + inventory operations platform — web (Next.js 16) + iOS/Android (Expo) + Supabase Postgres backend.

StockPilot is in production as the internal inventory system for L4L Fresno (a charter-school operation with four warehouses, ~10–20 staff). Pivoted 2026-05-04 from a public multi-tenant SaaS to an invite-only internal tool. Multi-tenant SaaS remains a path-B roadmap target — see [`docs/INVESTOR-MEETING-PREP.md`](./docs/INVESTOR-MEETING-PREP.md) for the current product positioning.

## Stack

- **Web:** Next.js 16 · TypeScript · Tailwind CSS v4 · shadcn/ui · TanStack Query · React Hook Form + Zod
- **Mobile:** Expo / React Native (iOS + Android) — scanning, counting, on-floor adjustments
- **Backend:** Supabase Postgres 16 (RLS, Auth, Storage, Realtime)
- **Email:** Resend + React Email
- **AI:** Google Gemini (chat assistant, shelf-scan CV, PO-import OCR)
- **Monorepo:** Turborepo + pnpm workspaces
- **Hosting:** Vercel (web) · Supabase (backend) · EAS (mobile)

## Repo layout

```
.
├── apps/
│   ├── web/                Next.js 16 marketing + dashboard
│   └── mobile/             Expo React Native app
├── packages/
│   ├── core/               Shared types, Zod schemas, constants
│   ├── db/                 Database documentation
│   └── config/             Shared tsconfig + ESLint preset
├── supabase/
│   ├── migrations/         SQL migrations — every schema change goes here
│   ├── config.toml         Local Supabase config
│   └── seed.sql            Local dev seed
└── docs/                   Investor materials, system guide, cost analysis
```

## Prerequisites

- **Node.js** 24.x (`nvm use` — `.nvmrc` points to 24, the major production runs on Vercel)
- **pnpm** ≥ 9 (`npm install -g pnpm`)
- **Supabase CLI** (`brew install supabase/tap/supabase`)
- **Vercel CLI** (recommended): `npm install -g vercel`

## Getting started

```bash
pnpm install
supabase start                 # boots local Postgres, Auth, Storage, Studio
cp apps/web/.env.example apps/web/.env.local   # fill from `supabase status`
pnpm dev                       # web app at http://localhost:3000
```

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Starts the web dev server (Turbopack) |
| `pnpm build` | Production build via Turbo |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm lint` | ESLint via Next.js + Expo |
| `pnpm format` | Prettier write |
| `pnpm db:reset` | Drop + reapply local migrations |
| `pnpm db:push` | Push pending migrations to linked Supabase project |
| `pnpm db:types` | Regenerate `packages/core/src/types/database.ts` |

## Environments

| Env | Hosting | DB |
|---|---|---|
| Local | `pnpm dev` | `supabase start` |
| Preview | Vercel preview per PR | Supabase dev project |
| Production | Vercel prod (stockpilotusa.com) | Supabase prod project |

## Creating a workspace

Public `/signup` is off (StockPilot is invite-only), and only a platform admin creates a workspace.

- **A customer's workspace:** Platform > Provision creates the customer's account, their workspace and their owner seat in one step, and emails them a sign-in link. It needs a verified sign-in email on `STOCKPILOT_PLATFORM_ADMIN_EMAILS` and an authenticator code from the last 15 minutes. An authenticator is set up under Settings > Security, inside a workspace.
- **A platform admin with no workspace** gets the create form on `/onboarding`, under the same two conditions. Everyone else with no workspace sees the invite-only card there, with Sign out, a link to the ordering portal and Delete my account.
- **Joining an existing workspace** is an invite from that workspace's Team page.

### Locally

`supabase db reset` seeds the workspace Acme Demo Co with no members (`supabase/seed.sql`). To use it, add a user in local Studio (Authentication > Users), then make that user its owner in Studio's SQL editor. Studio runs as `postgres`, so the owner-row guard lets the insert through:

```sql
insert into public.organization_members (organization_id, user_id, role, accepted_at)
values ('00000000-0000-0000-0000-000000000001', '<the user id>', 'owner', now());
```

Or run `node apps/web/scripts/perf-lab/seed.mjs --target=local` for a workspace with one account per role (see [`apps/web/scripts/perf-lab/README.md`](./apps/web/scripts/perf-lab/README.md)).

## Documentation

| File | Audience |
|---|---|
| [`docs/SYSTEM-GUIDE.md`](./docs/SYSTEM-GUIDE.md) | Engineers / architecture deep-dive |
| [`docs/WAREHOUSING-OVERVIEW.md`](./docs/WAREHOUSING-OVERVIEW.md) | Operators / what the system does in plain English |
| [`docs/COST-AND-VALUE.md`](./docs/COST-AND-VALUE.md) | Investors / customers — operating cost vs. commercial WMS |
| [`BLUEPRINT.md`](./BLUEPRINT.md) | Historical — pre-pivot architecture plan (superseded 2026-05-04) |
| [`SECURITY.md`](./SECURITY.md) | Security disclosure process |
