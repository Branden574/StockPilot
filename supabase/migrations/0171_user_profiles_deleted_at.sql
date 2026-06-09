-- 0171_user_profiles_deleted_at.sql
-- ─────────────────────────────────────────────────────────────────────
-- Add the missing `deleted_at` tombstone column to user_profiles.
--
-- deleteOwnAccountAction (apps/web/src/server/actions/profile.ts) soft-stamps
-- user_profiles.deleted_at BEFORE deleting the auth user, but the column was
-- never created in any migration — so the UPDATE failed with "column does not
-- exist", the ServiceError threw, and self-service account deletion was fully
-- broken (the auth user was never removed). Security audit 2026-06-09.
--
-- Nullable, no default: only set when a user deletes their own account. No index
-- — it's a write-once tombstone, not a hot-path filter.
-- ─────────────────────────────────────────────────────────────────────

alter table public.user_profiles
  add column if not exists deleted_at timestamptz;
