-- 0259: onboarding/product-adoption state (owner PRD 2026-07-11, spec §13).
-- One row per user. Backend persistence — browser state is explicitly not
-- enough (refresh/resume + cross-device requirements). jsonb maps keyed by
-- tour/announcement id so adding tours never needs a migration:
--   completed_tours:      { "items-page": {"v":1,"at":"...","platform":"web"} }
--   dismissed_tours:      { "items-page": {"v":1,"at":"..."} }
--   viewed_announcements: { "claim-picking": {"v":1,"at":"...","completedWalkthrough":true} }
--   last_tour_state:      { "tourId":"items-page","step":3 }  -- mid-tour resume
create table if not exists public.user_onboarding (
  user_id uuid primary key references auth.users(id) on delete cascade,
  onboarding_version int not null default 1,
  completed_tours jsonb not null default '{}',
  dismissed_tours jsonb not null default '{}',
  viewed_announcements jsonb not null default '{}',
  last_tour_state jsonb,
  role_at_onboarding text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_onboarding enable row level security;

-- Owner-only access: onboarding progress is personal, never org-shared.
create policy user_onboarding_select on public.user_onboarding
  for select using (user_id = auth.uid());
create policy user_onboarding_insert on public.user_onboarding
  for insert with check (user_id = auth.uid());
create policy user_onboarding_update on public.user_onboarding
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create trigger user_onboarding_touch_updated_at
  before update on public.user_onboarding
  for each row execute function public.tg_set_updated_at();
