-- 0067_grant_authenticated_on_post_2026_tables.sql
-- Backfills the table-level GRANT clauses on tables created after
-- 2026-10-30 that were missed when the project rule was adopted (per
-- the project memory feedback_supabase_explicit_grants.md). On
-- hardened Supabase projects, missing grants cause real-feature 403s
-- even when RLS would otherwise allow the row.
--
-- All idempotent: `grant ... on` is safe to re-run. Existing grants
-- on the same role/table are no-ops.

grant select, insert, update, delete on public.cycle_counts        to authenticated;
grant select, insert, update, delete on public.cycle_count_lines   to authenticated;
grant select, insert, update, delete on public.mfa_recovery_codes  to authenticated;
grant select, insert, update, delete on public.saved_views         to authenticated;
grant select, insert, update, delete on public.bundles             to authenticated;
grant select, insert, update, delete on public.bundle_components   to authenticated;
grant select, insert, update, delete on public.bundle_distributions to authenticated;
grant select, insert, update, delete on public.order_requests      to authenticated;
grant select, insert, update, delete on public.order_request_lines to authenticated;
grant select, insert, update, delete on public.stock_reservations  to authenticated;
grant select, insert, update, delete on public.rate_limit_buckets  to authenticated;
grant select, insert, update, delete on public.shipments           to authenticated;
grant select, insert, update, delete on public.shipment_lines      to authenticated;
grant select, insert, update, delete on public.procedure_categories to authenticated;
grant select, insert, update, delete on public.procedures          to authenticated;
grant select, insert, update, delete on public.procedure_videos    to authenticated;
grant select, insert, update, delete on public.procedure_comments  to authenticated;
