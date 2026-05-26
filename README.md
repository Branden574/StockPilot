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

- **Node.js** ≥ 20.11 (`nvm use` — `.nvmrc` points to 20.11.0)
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

## Onboarding a new org

Public `/signup` is intentionally disabled (StockPilot is invite-only). To onboard a new organization today, see the magic-link runbook in the Appendix of [`docs/INVESTOR-MEETING-PREP.md`](./docs/INVESTOR-MEETING-PREP.md) — about 5 minutes per org via the Supabase Dashboard.

## Documentation

| File | Audience |
|---|---|
| [`docs/SYSTEM-GUIDE.md`](./docs/SYSTEM-GUIDE.md) | Engineers / architecture deep-dive |
| [`docs/WAREHOUSING-OVERVIEW.md`](./docs/WAREHOUSING-OVERVIEW.md) | Operators / what the system does in plain English |
| [`docs/COST-AND-VALUE.md`](./docs/COST-AND-VALUE.md) | Investors / customers — operating cost vs. commercial WMS |
| [`docs/INVESTOR-MEETING-PREP.md`](./docs/INVESTOR-MEETING-PREP.md) | Founder — pitch workbook + onboarding runbook |
| [`BLUEPRINT.md`](./BLUEPRINT.md) | Historical — pre-pivot architecture plan (superseded 2026-05-04) |
| [`SECURITY.md`](./SECURITY.md) | Security disclosure process |
