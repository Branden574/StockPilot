-- 0402_explicit_data_api_grants.sql
--
-- GRANTS ONLY. Restates, object by object, every privilege the Data API roles
-- (anon, authenticated, service_role) held in production on 2026-10-24 on
-- each public table, view and sequence, table-level and column-level, so the
-- migrations stop relying on Supabase's default privileges for them. No
-- REVOKE, no DDL, no data change.
--
-- ── WHY (Supabase changelog 45329, "Breaking Change: Tables not exposed to
--    Data and GraphQL API automatically", published 2026-04-28) ─────────────
-- On 2026-10-30 Supabase applies to every existing project the statements its
-- dashboard runs for a new project created without "Automatically expose new
-- tables":
--   alter default privileges for role postgres in schema public
--     revoke select, insert, update, delete on tables from anon, authenticated, service_role;
--   alter default privileges for role postgres in schema public
--     revoke usage, select on sequences from anon, authenticated, service_role;
-- Postgres applies the TABLES defaults to tables, partitioned tables, views
-- and materialized views, and the SEQUENCES ones to every sequence, identity
-- and serial ones included (checked on 17.6). TRUNCATE, REFERENCES, TRIGGER
-- and MAINTAIN stay in the defaults, and so does UPDATE on sequences; function
-- defaults do not change. Existing objects keep their grants, so production
-- does not change that day. A database built FROM these migrations under the
-- new defaults does: it gets only what a migration grants by name. That is a
-- new project (new projects get these defaults by the rollout that began
-- 2026-05-30), and a local or CI stack once the CLI turns them on: the pinned
-- CLI 2.117.0 already has [api] auto_expose_new_tables, whose `false` revokes
-- the same defaults plus EXECUTE on functions from the same three roles.
-- Measured (migration scratch stack, the two statements run before 0001,
-- then 0001-0401): 1237 of production's 2852 table-level privileges were
-- missing, on 132 of the 145 relations; 74 of the 136 tables had no SELECT,
-- INSERT, UPDATE or DELETE for any of the three roles. Column grants were all
-- explicit already.
--
-- ── WHAT ──────────────────────────────────────────────────────────────────
-- One group per relation, sorted by name: its table-level grants (one
-- statement per set of roles that hold the same privileges), then its column
-- grants (user_profiles 0311, cycle_count_lines and cycle_count_ai_scans
-- 0368/0369, order_requests and schedule_events 0384/0388). A relation the
-- three roles hold nothing on is listed as a comment (item_grouping_requests).
-- A GRANT of a privilege already held changes nothing, so the file is
-- idempotent and grants nothing production does not have. Never replace it
-- with `grant ... on all tables in schema public`: that would undo the
-- migrations' 512 REVOKEs and the column-level grants.
--
-- ── HOW IT WAS MADE (2026-10-24) ──────────────────────────────────────────
-- scripts/explicit-grants/census.sql (read-only: pg_class.relacl and
-- pg_attribute.attacl) ran on production's public schema (a schema-only
-- `supabase db dump` of 2026-10-24 loaded into a scratch database) and on a
-- database built from 0001-0401 with today's defaults. The two censuses are
-- identical: 145 relations (136 tables, 8 views, 1 identity sequence), 2852
-- table-level and 102 column-level privileges of the three roles, all granted
-- by postgres, none with grant option. Function ACLs match too (324
-- functions). No drift. The block below is
--   node scripts/gen-explicit-grants-sql.mjs --census <census.json>
-- Before pushing, confirm production still matches: take the census read-only
-- from production and run the generator with --check (usage at the top of
-- scripts/gen-explicit-grants-sql.mjs).
--
-- ── PROOF UNDER THE NEW DEFAULTS (migration scratch stack, 2026-10-24) ────
-- With the two statements above run before 0001, 0001-0402 give the three
-- roles exactly production's privileges on all 145 relations and on every
-- column: none missing, none extra. The same holds when the defaults give
-- them nothing at all on tables and sequences (revoke all). The pgTAP suite
-- passes in both, and on the plain chain with today's defaults.
-- The plain chain does NOT reach this file under the new defaults: 0373's
-- preflight requires authenticated to hold INSERT and SELECT on
-- stock_movements, and 0398's post-check requires service_role to hold
-- INSERT, UPDATE or DELETE on returns and return_lines; only the old defaults
-- gave those (the proof wrapped the two files in a scratch-only shim that
-- granted them for the file and revoked them after). Until that is fixed, a
-- fresh database needs the old defaults to build: do not bump the CLI or
-- turn auto_expose_new_tables off.
-- Functions are not restated here: the platform change leaves their
-- defaults alone. The CLI's auto_expose_new_tables = false does revoke them,
-- and then service_role lacks EXECUTE on 116 functions whose grant came only
-- from the defaults (9 pgTAP tests fail); that needs its own catch-up before
-- any local stack runs with it.
--
-- ── WHO CHANGES AT PUSH ───────────────────────────────────────────────────
-- Nobody. Production holds every privilege below: applied twice to a copy of
-- production's ACLs, the file changed no relacl and no attacl.
--
-- ── LOCKS ─────────────────────────────────────────────────────────────────
-- None on any table: a GRANT on activity_logs finished in 9 ms while another
-- session held ACCESS EXCLUSIVE on it, and after the whole file in one
-- transaction the session held no relation lock. Each GRANT rewrites the
-- relation's pg_class row (pg_attribute rows for a column grant) even when it
-- changes nothing, so other sessions reload that relation's cache entry once.
--
-- ── ORDER ─────────────────────────────────────────────────────────────────
-- Push this before any later migration that revokes a privilege restated
-- here: applied after one, it would grant that privilege back. Every
-- migration from 0403 on that creates a public table, view or sequence grants
-- it explicitly in the same file.

-- BEGIN GENERATED: scripts/gen-explicit-grants-sql.mjs from a census (scripts/explicit-grants/census.sql). Do not edit by hand.
-- 145 relations in public (1 sequence, 136 tables, 8 views).
-- 2852 table-level and 102 column-level privileges of anon, authenticated and service_role;
-- 1 relation where those roles hold none.

-- public.activity_logs (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.activity_logs to anon, authenticated, service_role;

-- public.ai_chat_messages (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.ai_chat_messages to anon, authenticated, service_role;

-- public.ai_chat_sessions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.ai_chat_sessions to anon, authenticated, service_role;

-- public.api_keys (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.api_keys to anon, authenticated, service_role;

-- public.approvals (table)
grant select, maintain on table public.approvals to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.approvals to service_role;

-- public.audit_logs (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.audit_logs to anon, authenticated, service_role;

-- public.billing_events (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.billing_events to anon, authenticated, service_role;

-- public.bins (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.bins to anon, authenticated, service_role;

-- public.book_metadata_cache (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.book_metadata_cache to anon, authenticated, service_role;

-- public.bundle_components (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.bundle_components to anon, authenticated, service_role;

-- public.bundle_distributions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.bundle_distributions to anon, authenticated, service_role;

-- public.bundles (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.bundles to anon, authenticated, service_role;

-- public.carrier_shipments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.carrier_shipments to anon, authenticated, service_role;

-- public.categories (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.categories to anon, authenticated, service_role;

-- public.charters (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.charters to anon, authenticated, service_role;

-- public.connection_mappings (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.connection_mappings to anon, authenticated, service_role;

-- public.connection_sync_log (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.connection_sync_log to anon, authenticated, service_role;

-- public.custom_field_definitions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.custom_field_definitions to anon, authenticated, service_role;

-- public.customer_catalog (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.customer_catalog to anon, authenticated, service_role;

-- public.customer_users (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.customer_users to anon, authenticated, service_role;

-- public.customers (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.customers to anon, authenticated, service_role;

-- public.cycle_count_ai_scans (table)
grant select, references, trigger, maintain on table public.cycle_count_ai_scans to anon;
grant select, insert, delete, references, trigger, maintain
  on table public.cycle_count_ai_scans to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.cycle_count_ai_scans to service_role;
grant update (confirmed_at, confirmed_by) on table public.cycle_count_ai_scans to authenticated;

-- public.cycle_count_lines (table)
grant select, references, trigger, maintain on table public.cycle_count_lines to anon;
grant select, delete, references, trigger, maintain
  on table public.cycle_count_lines to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.cycle_count_lines to service_role;
grant insert (
    cycle_count_id, expected_quantity, item_id, warehouse_id
  ) on table public.cycle_count_lines to authenticated;
grant update (
    ai_scan_id, captured_at, counted_at, counted_by, counted_quantity, notes, reason
  ) on table public.cycle_count_lines to authenticated;

-- public.cycle_count_number_counters (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.cycle_count_number_counters to service_role;

-- public.cycle_counts (table)
grant select, references, trigger, maintain on table public.cycle_counts to anon;
grant select, insert, update, delete, references, trigger, maintain
  on table public.cycle_counts to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.cycle_counts to service_role;

-- public.delivery_locations (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.delivery_locations to anon, authenticated, service_role;

-- public.exception_evidence (table)
grant select on table public.exception_evidence to authenticated;
grant select, insert on table public.exception_evidence to service_role;

-- public.exception_occurrence_counters (table)
grant select, insert, update on table public.exception_occurrence_counters to service_role;

-- public.exception_occurrence_events (table)
grant select on table public.exception_occurrence_events to authenticated;
grant select, insert on table public.exception_occurrence_events to service_role;

-- public.exception_occurrences (table)
grant select on table public.exception_occurrences to authenticated;
grant select, insert, update on table public.exception_occurrences to service_role;

-- public.exception_sync_state (table)
grant select on table public.exception_sync_state to authenticated;
grant select, insert, update on table public.exception_sync_state to service_role;

-- public.export_presets (table)
grant select, insert, delete, references, trigger, maintain
  on table public.export_presets to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.export_presets to service_role;

-- public.idempotency_keys (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.idempotency_keys to anon, authenticated, service_role;

-- public.import_job_errors (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.import_job_errors to anon, authenticated, service_role;

-- public.import_jobs (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.import_jobs to anon, authenticated, service_role;

-- public.integration_deliveries (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.integration_deliveries to anon, authenticated, service_role;

-- public.integration_endpoints (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.integration_endpoints to anon, authenticated, service_role;

-- public.inventory_items (table)
grant select, maintain on table public.inventory_items to anon;
grant select, insert, update, maintain on table public.inventory_items to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.inventory_items to service_role;

-- public.inventory_stock (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.inventory_stock to anon, authenticated, service_role;

-- public.item_attachments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.item_attachments to anon, authenticated, service_role;

-- public.item_display_group_members (table)
grant select on table public.item_display_group_members to authenticated, service_role;

-- public.item_display_groups (table)
grant select on table public.item_display_groups to authenticated, service_role;

-- public.item_grouping_requests (table): no privileges for anon, authenticated or service_role.

-- public.item_images (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.item_images to anon, authenticated, service_role;

-- public.item_import_batches (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.item_import_batches to anon, authenticated, service_role;

-- public.item_price_observations (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.item_price_observations to anon, authenticated, service_role;

-- public.item_stock_levels (table)
grant select, maintain on table public.item_stock_levels to anon;
grant select, insert, update, maintain on table public.item_stock_levels to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.item_stock_levels to service_role;

-- public.item_tags (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.item_tags to anon, authenticated, service_role;

-- public.locations (table)
grant select, insert, update, truncate, references, trigger, maintain
  on table public.locations to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.locations to service_role;

-- public.lot_pick_events (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.lot_pick_events to anon, authenticated, service_role;

-- public.maintenance_request_attachments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.maintenance_request_attachments to anon, authenticated, service_role;

-- public.maintenance_request_notes (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.maintenance_request_notes to anon, authenticated, service_role;

-- public.maintenance_request_share_links (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.maintenance_request_share_links to anon, authenticated, service_role;

-- public.maintenance_requests (table)
grant select, maintain on table public.maintenance_requests to anon;
grant select, insert, update, maintain on table public.maintenance_requests to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.maintenance_requests to service_role;

-- public.member_activity (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.member_activity to service_role;

-- public.mfa_recovery_codes (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.mfa_recovery_codes to anon, authenticated, service_role;

-- public.notification_preferences (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.notification_preferences to anon, authenticated, service_role;

-- public.notifications (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.notifications to anon, authenticated, service_role;

-- public.order_email_log (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.order_email_log to service_role;

-- public.order_request_attachments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.order_request_attachments to anon, authenticated, service_role;

-- public.order_request_lines (table)
grant select, maintain on table public.order_request_lines to anon;
grant select, insert, maintain on table public.order_request_lines to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.order_request_lines to service_role;

-- public.order_request_secrets (table)
grant select, insert, update, delete on table public.order_request_secrets to service_role;

-- public.order_requests (table)
grant select, delete on table public.order_requests to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.order_requests to service_role;
grant insert (
    delivery_charter_id, fulfillment_type, needed_by, notes, organization_id,
    pickup_location_notes, requester_email, requester_name, requester_phone, requester_user_id,
    source, status, warehouse_id
  ) on table public.order_requests to authenticated;
grant update (
    created_at, delivery_charter_id, denied_reason, internal_notes, pick_slip_generated_at,
    pick_slip_generated_by, staged_at, staged_by, status, warehouse_id
  ) on table public.order_requests to authenticated;

-- public.order_submissions (table)
grant select, insert on table public.order_submissions to authenticated;
grant select on table public.order_submissions to service_role;

-- public.org_connections (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.org_connections to anon, authenticated, service_role;

-- public.org_daily_movement_stats (table)
grant select, references, trigger, maintain
  on table public.org_daily_movement_stats to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.org_daily_movement_stats to service_role;

-- public.org_daily_stats (table)
grant select, references, trigger, maintain on table public.org_daily_stats to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.org_daily_stats to service_role;

-- public.organization_invites (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.organization_invites to anon, authenticated, service_role;

-- public.organization_members (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.organization_members to anon, authenticated, service_role;

-- public.organization_modules (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.organization_modules to anon, authenticated, service_role;

-- public.organizations (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.organizations to anon, authenticated, service_role;

-- public.outbox_events (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.outbox_events to anon, authenticated, service_role;

-- public.platform_admin_audit (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.platform_admin_audit to anon, authenticated, service_role;

-- public.platform_impersonation_sessions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.platform_impersonation_sessions to anon, authenticated, service_role;

-- public.platform_settings (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.platform_settings to anon, authenticated, service_role;

-- public.po_attachments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.po_attachments to anon, authenticated, service_role;

-- public.po_import_lines (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.po_import_lines to anon, authenticated, service_role;

-- public.po_imports (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.po_imports to anon, authenticated, service_role;

-- public.price_list_items (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.price_list_items to anon, authenticated, service_role;

-- public.price_lists (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.price_lists to anon, authenticated, service_role;

-- public.procedure_categories (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.procedure_categories to anon, authenticated, service_role;

-- public.procedure_comments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.procedure_comments to anon, authenticated, service_role;

-- public.procedure_videos (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.procedure_videos to anon, authenticated, service_role;

-- public.procedures (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.procedures to anon, authenticated, service_role;

-- public.product_group_rollups (view)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.product_group_rollups to anon, authenticated, service_role;

-- public.product_groups (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.product_groups to anon, authenticated, service_role;

-- public.public_email_unsubscribes (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.public_email_unsubscribes to service_role;

-- public.public_link_catalog_entries (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.public_link_catalog_entries to anon, authenticated, service_role;

-- public.public_request_links (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.public_request_links to anon, authenticated, service_role;

-- public.purchase_order_charges (table)
grant select, maintain on table public.purchase_order_charges to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.purchase_order_charges to service_role;

-- public.purchase_order_items (table)
grant select, maintain on table public.purchase_order_items to anon;
grant select, insert, update, delete, maintain
  on table public.purchase_order_items to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.purchase_order_items to service_role;

-- public.purchase_orders (table)
grant select, maintain on table public.purchase_orders to anon;
grant select, insert, update, maintain on table public.purchase_orders to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.purchase_orders to service_role;

-- public.push_tokens (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.push_tokens to anon, authenticated, service_role;

-- public.putaway_moves (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.putaway_moves to anon, authenticated, service_role;

-- public.rate_limit_buckets (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.rate_limit_buckets to anon, authenticated, service_role;

-- public.receipt_line_lots (table)
grant select, maintain on table public.receipt_line_lots to anon;
grant select, insert, update, delete, maintain on table public.receipt_line_lots to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.receipt_line_lots to service_role;

-- public.receipt_lines (table)
grant select, maintain on table public.receipt_lines to anon;
grant select, insert, update, delete, maintain on table public.receipt_lines to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.receipt_lines to service_role;

-- public.receipts (table)
grant select, maintain on table public.receipts to anon;
grant select, insert, update, delete, maintain on table public.receipts to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.receipts to service_role;

-- public.recurring_po_templates (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.recurring_po_templates to anon, authenticated, service_role;

-- public.rental_lines (table)
grant select, maintain on table public.rental_lines to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.rental_lines to service_role;

-- public.rentals (table)
grant select, maintain on table public.rentals to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.rentals to service_role;

-- public.restore_points (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.restore_points to anon, authenticated, service_role;

-- public.return_decisions (table)
grant select on table public.return_decisions to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.return_decisions to service_role;

-- public.return_decisions_seq_seq (sequence)
grant usage, select, update
  on sequence public.return_decisions_seq_seq to anon, authenticated, service_role;

-- public.return_exchange_lines (table)
grant select on table public.return_exchange_lines to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.return_exchange_lines to service_role;

-- public.return_lines (table)
grant select on table public.return_lines to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.return_lines to service_role;

-- public.return_overview (view)
grant select on table public.return_overview to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.return_overview to service_role;

-- public.returns (table)
grant select on table public.returns to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.returns to service_role;

-- public.role_default_permissions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.role_default_permissions to anon, authenticated, service_role;

-- public.role_permission_overrides (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.role_permission_overrides to anon, authenticated, service_role;

-- public.saved_views (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.saved_views to anon, authenticated, service_role;

-- public.schedule_events (table)
grant select, references, trigger, maintain on table public.schedule_events to anon;
grant select, delete, references, trigger, maintain
  on table public.schedule_events to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.schedule_events to service_role;
grant insert (
    all_day, bundle_id, bundle_quantity, bundle_warehouse_id, created_at, created_by, details,
    ends_at, id, location_text, organization_id, reminded_1h_at, reminded_24h_at, requester_name,
    starts_at, status, title, updated_at, updated_by, warehouse_id
  ) on table public.schedule_events to authenticated;
grant update (
    all_day, bundle_id, bundle_quantity, bundle_warehouse_id, created_by, details, ends_at,
    location_text, organization_id, reminded_1h_at, reminded_24h_at, requester_name, starts_at,
    status, title, updated_at, updated_by, warehouse_id
  ) on table public.schedule_events to authenticated;

-- public.serial_registry (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.serial_registry to anon, authenticated, service_role;

-- public.shipment_lines (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.shipment_lines to anon, authenticated, service_role;

-- public.shipments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.shipments to anon, authenticated, service_role;

-- public.size_count_adjustments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.size_count_adjustments to anon, authenticated, service_role;

-- public.size_count_events (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.size_count_events to anon, authenticated, service_role;

-- public.size_count_sessions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.size_count_sessions to anon, authenticated, service_role;

-- public.size_count_training_samples (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.size_count_training_samples to anon, authenticated, service_role;

-- public.size_scale_values (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.size_scale_values to anon, authenticated, service_role;

-- public.size_scales (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.size_scales to anon, authenticated, service_role;

-- public.stock_movement_holdings (view)
grant select on table public.stock_movement_holdings to authenticated, service_role;

-- public.stock_movements (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.stock_movements to anon, authenticated, service_role;

-- public.stock_reservations (table)
grant select, maintain on table public.stock_reservations to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.stock_reservations to service_role;

-- public.suppliers (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.suppliers to anon, authenticated, service_role;

-- public.support_tickets (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.support_tickets to anon, authenticated, service_role;

-- public.tags (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.tags to anon, authenticated, service_role;

-- public.tolerance_profiles (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.tolerance_profiles to anon, authenticated, service_role;

-- public.uom_conversions (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.uom_conversions to anon, authenticated, service_role;

-- public.user_category_assignments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_category_assignments to anon, authenticated, service_role;

-- public.user_login_devices (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_login_devices to anon, authenticated, service_role;

-- public.user_onboarding (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_onboarding to anon, authenticated, service_role;

-- public.user_permission_overrides (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_permission_overrides to anon, authenticated, service_role;

-- public.user_profiles (table)
grant insert, update, delete, truncate, references, trigger, maintain
  on table public.user_profiles to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_profiles to service_role;
grant select (
    avatar_url, created_at, default_organization_id, deleted_at, digest_section_cycle_counts,
    digest_section_low_stock, digest_section_open_pos, disabled_at, email, email_digest_optin,
    full_name, id, onboarding_dismissed_at, updated_at
  ) on table public.user_profiles to anon, authenticated;

-- public.user_release_state (table)
grant select, insert, update, maintain on table public.user_release_state to authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_release_state to service_role;

-- public.user_session_names (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_session_names to service_role;

-- public.user_warehouse_assignments (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.user_warehouse_assignments to anon, authenticated, service_role;

-- public.vendor_item_mappings (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.vendor_item_mappings to anon, authenticated, service_role;

-- public.vw_inventory_valuation_by_category (view)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.vw_inventory_valuation_by_category to anon, authenticated, service_role;

-- public.vw_inventory_valuation_by_warehouse (view)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.vw_inventory_valuation_by_warehouse to anon, authenticated, service_role;

-- public.vw_po_reconciliation (view)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.vw_po_reconciliation to anon, authenticated, service_role;

-- public.vw_vendor_performance (view)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.vw_vendor_performance to anon, authenticated, service_role;

-- public.vw_warehouse_inbound (view)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.vw_warehouse_inbound to anon, authenticated, service_role;

-- public.warehouse_charters (table)
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.warehouse_charters to anon, authenticated, service_role;

-- public.warehouses (table)
grant select, insert, update, truncate, references, trigger, maintain
  on table public.warehouses to anon, authenticated;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on table public.warehouses to service_role;

-- END GENERATED
