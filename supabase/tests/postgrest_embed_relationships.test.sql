-- supabase/tests/postgrest_embed_relationships.test.sql
-- The relationships PostgREST builds embeds from must match the committed
-- snapshot, scripts/postgrest-embeds/relationships.snapshot.json.
--
-- WHY. When two tables are joined by more than one relationship, PostgREST
-- refuses an embed that does not name one (HTTP 300, PGRST201). The weekly
-- digest cron embedded organization_members from user_profiles (two foreign
-- keys: user_id, invited_by) and failed every Monday without anyone seeing it.
-- The static guard apps/web/src/test/postgrest-embeds.guard.test.ts now checks
-- every select in web, phone and core against the snapshot. This file keeps the
-- snapshot honest: a migration that adds, drops or renames a foreign key, or
-- changes a junction table's primary key, fails here until the snapshot is
-- regenerated, and the regenerated snapshot puts the guard on the new
-- relationships.
--
-- A SNAPSHOT, ON PURPOSE. security_invariants.test.sql asserts properties and
-- never snapshots. This file is different in kind: it is the drift detector
-- for a static check that cannot read the database, so an exact comparison is
-- the property ("the guard's input is the database's truth").
--
--   1. every public foreign key (name, table, columns, referenced table and
--      columns), exactly;
--   2. every junction PostgREST sees: two foreign keys of one table whose
--      columns all sit in its primary key give one many-to-many relationship
--      (a unique constraint is not enough), exactly;
--   3. the ambiguous pairs: two tables joined by two or more relationships,
--      with the relationships PostgREST would offer as hints, exactly.
-- The rules match scripts/postgrest-embeds/relationships.mjs, which was
-- checked against the local stack's PostgREST 14 on 2026-10-05 (all 674
-- directional embeds between related tables answered as predicted).
--
-- IF THIS FAILS after a migration: regenerate, then fix what the guard says.
--   pnpm exec supabase db reset                      (local stack only)
--   node scripts/gen-postgrest-embed-snapshot.mjs     (rewrites the snapshot and the block below)
--   pnpm --filter @stockpilot/web exec vitest run src/test/postgrest-embeds.guard.test.ts
-- A new ambiguous pair means every embed between those two tables must name
-- its relationship (a hint such as `user_profiles!orders_approved_by_fkey(...)`
-- or a column embed such as `approver:approved_by(...)`).

begin;
select plan(3);

create temporary table expected_fks (tbl text, name text, ref_tbl text, cols text, ref_cols text) on commit drop;
create temporary table expected_junctions (junction text, a text, b text, a_fk text, b_fk text) on commit drop;
create temporary table expected_pairs (a text, b text, relationships text) on commit drop;

-- BEGIN GENERATED: scripts/gen-postgrest-embed-snapshot.mjs from scripts/postgrest-embeds/relationships.snapshot.json. Do not edit by hand.
-- 390 foreign keys, 8 junctions, 33 ambiguous pairs.
insert into expected_fks (tbl, name, ref_tbl, cols, ref_cols) values
  ('activity_logs', 'activity_logs_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('activity_logs', 'activity_logs_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('ai_chat_messages', 'ai_chat_messages_session_id_fkey', 'ai_chat_sessions', 'session_id', 'id'),
  ('ai_chat_sessions', 'ai_chat_sessions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('api_keys', 'api_keys_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('api_keys', 'api_keys_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('approvals', 'approvals_decided_by_fkey', 'user_profiles', 'decided_by', 'id'),
  ('approvals', 'approvals_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('approvals', 'approvals_requested_by_fkey', 'user_profiles', 'requested_by', 'id'),
  ('audit_logs', 'audit_logs_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('audit_logs', 'audit_logs_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('billing_events', 'billing_events_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('bins', 'bins_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('bins', 'bins_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('bundle_components', 'bundle_components_bundle_id_fkey', 'bundles', 'bundle_id', 'id'),
  ('bundle_components', 'bundle_components_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('bundle_distributions', 'bundle_distributions_bundle_id_fkey', 'bundles', 'bundle_id', 'id'),
  ('bundle_distributions', 'bundle_distributions_distributed_by_fkey', 'user_profiles', 'distributed_by', 'id'),
  ('bundle_distributions', 'bundle_distributions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('bundle_distributions', 'bundle_distributions_schedule_event_id_fkey', 'schedule_events', 'schedule_event_id', 'id'),
  ('bundle_distributions', 'bundle_distributions_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('bundles', 'bundles_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('bundles', 'bundles_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('bundles', 'bundles_phantom_item_id_fkey', 'inventory_items', 'phantom_item_id', 'id'),
  ('bundles', 'bundles_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('carrier_shipments', 'carrier_shipments_connection_id_fkey', 'org_connections', 'connection_id', 'id'),
  ('carrier_shipments', 'carrier_shipments_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('carrier_shipments', 'carrier_shipments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('carrier_shipments', 'carrier_shipments_purchased_by_fkey', 'user_profiles', 'purchased_by', 'id'),
  ('categories', 'categories_deleted_by_fkey', 'user_profiles', 'deleted_by', 'id'),
  ('categories', 'categories_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('categories', 'categories_parent_id_fkey', 'categories', 'parent_id', 'id'),
  ('categories', 'categories_size_scale_id_fkey', 'size_scales', 'size_scale_id', 'id'),
  ('charters', 'charters_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('charters', 'charters_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('connection_mappings', 'connection_mappings_connection_id_fkey', 'org_connections', 'connection_id', 'id'),
  ('connection_mappings', 'connection_mappings_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('connection_sync_log', 'connection_sync_log_connection_id_fkey', 'org_connections', 'connection_id', 'id'),
  ('connection_sync_log', 'connection_sync_log_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('connection_sync_log', 'connection_sync_log_outbox_event_id_fkey', 'outbox_events', 'outbox_event_id', 'id'),
  ('custom_field_definitions', 'custom_field_definitions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('customer_catalog', 'customer_catalog_customer_id_fkey', 'customers', 'customer_id', 'id'),
  ('customer_catalog', 'customer_catalog_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('customer_users', 'customer_users_customer_id_fkey', 'customers', 'customer_id', 'id'),
  ('customers', 'customers_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('customers', 'customers_price_list_fk', 'price_lists', 'price_list_id', 'id'),
  ('cycle_count_ai_scans', 'cycle_count_ai_scans_confirmed_by_fkey', 'user_profiles', 'confirmed_by', 'id'),
  ('cycle_count_ai_scans', 'cycle_count_ai_scans_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('cycle_count_ai_scans', 'cycle_count_ai_scans_cycle_count_id_fkey', 'cycle_counts', 'cycle_count_id', 'id'),
  ('cycle_count_ai_scans', 'cycle_count_ai_scans_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('cycle_count_lines', 'cycle_count_lines_ai_scan_id_fkey', 'cycle_count_ai_scans', 'ai_scan_id', 'id'),
  ('cycle_count_lines', 'cycle_count_lines_counted_by_fkey', 'user_profiles', 'counted_by', 'id'),
  ('cycle_count_lines', 'cycle_count_lines_counted_location_id_fkey', 'locations', 'counted_location_id', 'id'),
  ('cycle_count_lines', 'cycle_count_lines_cycle_count_id_fkey', 'cycle_counts', 'cycle_count_id', 'id'),
  ('cycle_count_lines', 'cycle_count_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('cycle_count_lines', 'cycle_count_lines_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('cycle_count_number_counters', 'cycle_count_number_counters_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('cycle_counts', 'cycle_counts_assigned_to_fkey', 'user_profiles', 'assigned_to', 'id'),
  ('cycle_counts', 'cycle_counts_assignment_claimed_by_fkey', 'user_profiles', 'assignment_claimed_by', 'id'),
  ('cycle_counts', 'cycle_counts_canceled_by_fkey', 'user_profiles', 'canceled_by', 'id'),
  ('cycle_counts', 'cycle_counts_completed_by_fkey', 'user_profiles', 'completed_by', 'id'),
  ('cycle_counts', 'cycle_counts_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('cycle_counts', 'cycle_counts_started_by_fkey', 'user_profiles', 'started_by', 'id'),
  ('cycle_counts', 'cycle_counts_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('delivery_locations', 'delivery_locations_driver_user_id_fkey', 'user_profiles', 'driver_user_id', 'id'),
  ('delivery_locations', 'delivery_locations_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('delivery_locations', 'delivery_locations_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('exception_evidence', 'exception_evidence_occurrence_id_fkey', 'exception_occurrences', 'occurrence_id', 'id'),
  ('exception_evidence', 'exception_evidence_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('exception_evidence', 'exception_evidence_removed_by_fkey', 'user_profiles', 'removed_by', 'id'),
  ('exception_evidence', 'exception_evidence_uploaded_by_fkey', 'user_profiles', 'uploaded_by', 'id'),
  ('exception_occurrence_counters', 'exception_occurrence_counters_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('exception_occurrence_events', 'exception_occurrence_events_actor_user_id_fkey', 'user_profiles', 'actor_user_id', 'id'),
  ('exception_occurrence_events', 'exception_occurrence_events_cycle_count_id_fkey', 'cycle_counts', 'cycle_count_id', 'id'),
  ('exception_occurrence_events', 'exception_occurrence_events_evidence_id_fkey', 'exception_evidence', 'evidence_id', 'id'),
  ('exception_occurrence_events', 'exception_occurrence_events_maintenance_request_id_fkey', 'maintenance_requests', 'maintenance_request_id', 'id'),
  ('exception_occurrence_events', 'exception_occurrence_events_occurrence_id_fkey', 'exception_occurrences', 'occurrence_id', 'id'),
  ('exception_occurrence_events', 'exception_occurrence_events_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_acknowledged_by_fkey', 'user_profiles', 'acknowledged_by', 'id'),
  ('exception_occurrences', 'exception_occurrences_confirmed_by_fkey', 'user_profiles', 'confirmed_by', 'id'),
  ('exception_occurrences', 'exception_occurrences_confirmed_cycle_count_id_fkey', 'cycle_counts', 'confirmed_cycle_count_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_escalated_by_fkey', 'user_profiles', 'escalated_by', 'id'),
  ('exception_occurrences', 'exception_occurrences_escalation_claimed_by_fkey', 'user_profiles', 'escalation_claimed_by', 'id'),
  ('exception_occurrences', 'exception_occurrences_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_location_id_fkey', 'locations', 'location_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_maintenance_request_id_fkey', 'maintenance_requests', 'maintenance_request_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_previous_occurrence_id_fkey', 'exception_occurrences', 'previous_occurrence_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_recount_cycle_count_id_fkey', 'cycle_counts', 'recount_cycle_count_id', 'id'),
  ('exception_occurrences', 'exception_occurrences_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('exception_sync_state', 'exception_sync_state_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('export_presets', 'export_presets_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('idempotency_keys', 'idempotency_keys_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('import_job_errors', 'import_job_errors_import_job_id_fkey', 'import_jobs', 'import_job_id', 'id'),
  ('import_jobs', 'import_jobs_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('import_jobs', 'import_jobs_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('integration_deliveries', 'integration_deliveries_endpoint_id_fkey', 'integration_endpoints', 'endpoint_id', 'id'),
  ('integration_deliveries', 'integration_deliveries_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('integration_endpoints', 'integration_endpoints_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('integration_endpoints', 'integration_endpoints_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('inventory_items', 'inventory_items_category_id_fkey', 'categories', 'category_id', 'id'),
  ('inventory_items', 'inventory_items_charter_id_fkey', 'charters', 'charter_id', 'id'),
  ('inventory_items', 'inventory_items_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('inventory_items', 'inventory_items_created_from_purchase_order_id_fkey', 'purchase_orders', 'created_from_purchase_order_id', 'id'),
  ('inventory_items', 'inventory_items_deleted_by_fkey', 'user_profiles', 'deleted_by', 'id'),
  ('inventory_items', 'inventory_items_group_id_fkey', 'product_groups', 'group_id', 'id'),
  ('inventory_items', 'inventory_items_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('inventory_items', 'inventory_items_primary_location_id_fkey', 'locations', 'primary_location_id', 'id'),
  ('inventory_items', 'inventory_items_supplier_id_fkey', 'suppliers', 'supplier_id', 'id'),
  ('inventory_items', 'inventory_items_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('inventory_items', 'inventory_items_warehouse_charter_fk', 'warehouse_charters', 'warehouse_id,charter_id', 'warehouse_id,charter_id'),
  ('inventory_items', 'inventory_items_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('inventory_stock', 'inventory_stock_bin_id_fkey', 'bins', 'bin_id', 'id'),
  ('inventory_stock', 'inventory_stock_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('inventory_stock', 'inventory_stock_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('inventory_stock', 'inventory_stock_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('item_attachments', 'item_attachments_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('item_attachments', 'item_attachments_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('item_attachments', 'item_attachments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('item_images', 'item_images_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('item_images', 'item_images_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('item_import_batches', 'item_import_batches_imported_by_fkey', 'user_profiles', 'imported_by', 'id'),
  ('item_import_batches', 'item_import_batches_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('item_import_batches', 'item_import_batches_superseded_by_id_fkey', 'item_import_batches', 'superseded_by_id', 'id'),
  ('item_price_observations', 'item_price_observations_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('item_price_observations', 'item_price_observations_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('item_stock_levels', 'item_stock_levels_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('item_stock_levels', 'item_stock_levels_location_id_fkey', 'locations', 'location_id', 'id'),
  ('item_stock_levels', 'item_stock_levels_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('item_tags', 'item_tags_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('item_tags', 'item_tags_tag_id_fkey', 'tags', 'tag_id', 'id'),
  ('locations', 'locations_deleted_by_fkey', 'user_profiles', 'deleted_by', 'id'),
  ('locations', 'locations_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('locations', 'locations_parent_id_fkey', 'locations', 'parent_id', 'id'),
  ('locations', 'locations_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('lot_pick_events', 'lot_pick_events_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('lot_pick_events', 'lot_pick_events_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('lot_pick_events', 'lot_pick_events_order_request_line_id_fkey', 'order_request_lines', 'order_request_line_id', 'id'),
  ('lot_pick_events', 'lot_pick_events_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('maintenance_request_attachments', 'maintenance_request_attachments_maintenance_request_id_fkey', 'maintenance_requests', 'maintenance_request_id', 'id'),
  ('maintenance_request_attachments', 'maintenance_request_attachments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('maintenance_request_notes', 'maintenance_request_notes_maintenance_request_id_fkey', 'maintenance_requests', 'maintenance_request_id', 'id'),
  ('maintenance_request_notes', 'maintenance_request_notes_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('maintenance_request_share_links', 'maintenance_request_share_links_maintenance_request_id_fkey', 'maintenance_requests', 'maintenance_request_id', 'id'),
  ('maintenance_request_share_links', 'maintenance_request_share_links_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_charter_id_fkey', 'charters', 'charter_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_related_item_id_fkey', 'inventory_items', 'related_item_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_related_location_id_fkey', 'locations', 'related_location_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_related_order_request_id_fkey', 'order_requests', 'related_order_request_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_related_rental_id_fkey', 'rentals', 'related_rental_id', 'id'),
  ('maintenance_requests', 'maintenance_requests_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('member_activity', 'member_activity_organization_id_user_id_fkey', 'organization_members', 'organization_id,user_id', 'organization_id,user_id'),
  ('notification_preferences', 'notification_preferences_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('notifications', 'notifications_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('notifications', 'notifications_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('order_email_log', 'order_email_log_order_id_fkey', 'order_requests', 'order_id', 'id'),
  ('order_request_attachments', 'order_request_attachments_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('order_request_attachments', 'order_request_attachments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('order_request_attachments', 'order_request_attachments_uploaded_by_fkey', 'user_profiles', 'uploaded_by', 'id'),
  ('order_request_lines', 'order_request_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('order_request_lines', 'order_request_lines_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('order_request_lines', 'order_request_lines_packed_by_fkey', 'user_profiles', 'packed_by', 'id'),
  ('order_request_lines', 'order_request_lines_picked_by_fkey', 'user_profiles', 'picked_by', 'id'),
  ('order_request_secrets', 'order_request_secrets_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('order_request_secrets', 'order_request_secrets_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('order_requests', 'order_requests_approved_by_fkey', 'user_profiles', 'approved_by', 'id'),
  ('order_requests', 'order_requests_assigned_delivery_by_fkey', 'user_profiles', 'assigned_delivery_by', 'id'),
  ('order_requests', 'order_requests_assigned_delivery_user_id_fkey', 'user_profiles', 'assigned_delivery_user_id', 'id'),
  ('order_requests', 'order_requests_assigned_picker_id_fkey', 'user_profiles', 'assigned_picker_id', 'id'),
  ('order_requests', 'order_requests_cancelled_by_fkey', 'user_profiles', 'cancelled_by', 'id'),
  ('order_requests', 'order_requests_completed_by_fkey', 'user_profiles', 'completed_by', 'id'),
  ('order_requests', 'order_requests_customer_id_fkey', 'customers', 'customer_id', 'id'),
  ('order_requests', 'order_requests_delivery_charter_id_fkey', 'charters', 'delivery_charter_id', 'id'),
  ('order_requests', 'order_requests_in_transit_by_fkey', 'user_profiles', 'in_transit_by', 'id'),
  ('order_requests', 'order_requests_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('order_requests', 'order_requests_packing_slip_generated_by_fkey', 'user_profiles', 'packing_slip_generated_by', 'id'),
  ('order_requests', 'order_requests_pick_slip_generated_by_fkey', 'user_profiles', 'pick_slip_generated_by', 'id'),
  ('order_requests', 'order_requests_picking_claimed_by_fkey', 'user_profiles', 'picking_claimed_by', 'id'),
  ('order_requests', 'order_requests_picking_completed_by_fkey', 'user_profiles', 'picking_completed_by', 'id'),
  ('order_requests', 'order_requests_requester_user_id_fkey', 'user_profiles', 'requester_user_id', 'id'),
  ('order_requests', 'order_requests_staged_by_fkey', 'user_profiles', 'staged_by', 'id'),
  ('order_requests', 'order_requests_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('order_submissions', 'order_submissions_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('order_submissions', 'order_submissions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('order_submissions', 'order_submissions_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('org_connections', 'org_connections_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('org_connections', 'org_connections_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('org_daily_movement_stats', 'org_daily_movement_stats_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('org_daily_stats', 'org_daily_stats_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('organization_invites', 'organization_invites_charter_id_fkey', 'charters', 'charter_id', 'id'),
  ('organization_invites', 'organization_invites_invited_by_fkey', 'user_profiles', 'invited_by', 'id'),
  ('organization_invites', 'organization_invites_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('organization_invites', 'organization_invites_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('organization_members', 'organization_members_invited_by_fkey', 'user_profiles', 'invited_by', 'id'),
  ('organization_members', 'organization_members_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('organization_members', 'organization_members_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('organization_modules', 'organization_modules_enabled_by_fkey', 'user_profiles', 'enabled_by', 'id'),
  ('organization_modules', 'organization_modules_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('outbox_events', 'outbox_events_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('platform_admin_audit', 'platform_admin_audit_actor_user_id_fkey', 'user_profiles', 'actor_user_id', 'id'),
  ('platform_admin_audit', 'platform_admin_audit_target_organization_id_fkey', 'organizations', 'target_organization_id', 'id'),
  ('platform_admin_audit', 'platform_admin_audit_target_user_id_fkey', 'user_profiles', 'target_user_id', 'id'),
  ('platform_impersonation_sessions', 'platform_impersonation_sessions_admin_user_id_fkey', 'user_profiles', 'admin_user_id', 'id'),
  ('platform_impersonation_sessions', 'platform_impersonation_sessions_previous_organization_id_fkey', 'organizations', 'previous_organization_id', 'id'),
  ('platform_impersonation_sessions', 'platform_impersonation_sessions_target_organization_id_fkey', 'organizations', 'target_organization_id', 'id'),
  ('platform_settings', 'platform_settings_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('po_attachments', 'po_attachments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('po_attachments', 'po_attachments_purchase_order_id_fkey', 'purchase_orders', 'purchase_order_id', 'id'),
  ('po_attachments', 'po_attachments_uploaded_by_fkey', 'user_profiles', 'uploaded_by', 'id'),
  ('po_import_lines', 'po_import_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('po_import_lines', 'po_import_lines_po_import_id_fkey', 'po_imports', 'po_import_id', 'id'),
  ('po_import_lines', 'po_import_lines_suggested_group_id_fkey', 'product_groups', 'suggested_group_id', 'id'),
  ('po_import_lines', 'po_import_lines_suggested_item_id_fkey', 'inventory_items', 'suggested_item_id', 'id'),
  ('po_imports', 'po_imports_approved_by_fkey', 'user_profiles', 'approved_by', 'id'),
  ('po_imports', 'po_imports_approved_po_id_fkey', 'purchase_orders', 'approved_po_id', 'id'),
  ('po_imports', 'po_imports_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('po_imports', 'po_imports_reimported_from_id_fkey', 'po_imports', 'reimported_from_id', 'id'),
  ('po_imports', 'po_imports_uploaded_by_fkey', 'user_profiles', 'uploaded_by', 'id'),
  ('po_imports', 'po_imports_vendor_id_fkey', 'suppliers', 'vendor_id', 'id'),
  ('po_imports', 'po_imports_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('price_list_items', 'price_list_items_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('price_list_items', 'price_list_items_price_list_id_fkey', 'price_lists', 'price_list_id', 'id'),
  ('price_lists', 'price_lists_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('procedure_categories', 'procedure_categories_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('procedure_comments', 'procedure_comments_author_id_fkey', 'user_profiles', 'author_id', 'id'),
  ('procedure_comments', 'procedure_comments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('procedure_comments', 'procedure_comments_parent_id_fkey', 'procedure_comments', 'parent_id', 'id'),
  ('procedure_comments', 'procedure_comments_procedure_id_fkey', 'procedures', 'procedure_id', 'id'),
  ('procedure_videos', 'procedure_videos_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('procedure_videos', 'procedure_videos_procedure_id_fkey', 'procedures', 'procedure_id', 'id'),
  ('procedure_videos', 'procedure_videos_uploaded_by_fkey', 'user_profiles', 'uploaded_by', 'id'),
  ('procedures', 'procedures_authoring_warehouse_id_fkey', 'warehouses', 'authoring_warehouse_id', 'id'),
  ('procedures', 'procedures_category_id_fkey', 'procedure_categories', 'category_id', 'id'),
  ('procedures', 'procedures_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('procedures', 'procedures_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('procedures', 'procedures_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('product_groups', 'product_groups_category_id_fkey', 'categories', 'category_id', 'id'),
  ('product_groups', 'product_groups_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('product_groups', 'product_groups_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('product_groups', 'product_groups_size_scale_id_fkey', 'size_scales', 'size_scale_id', 'id'),
  ('product_groups', 'product_groups_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('public_link_catalog_entries', 'public_link_catalog_entries_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('public_link_catalog_entries', 'public_link_catalog_entries_link_id_fkey', 'public_request_links', 'link_id', 'id'),
  ('public_request_links', 'public_request_links_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('purchase_order_charges', 'purchase_order_charges_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('purchase_order_charges', 'purchase_order_charges_purchase_order_id_fkey', 'purchase_orders', 'purchase_order_id', 'id'),
  ('purchase_order_items', 'purchase_order_items_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('purchase_order_items', 'purchase_order_items_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('purchase_order_items', 'purchase_order_items_purchase_order_id_fkey', 'purchase_orders', 'purchase_order_id', 'id'),
  ('purchase_orders', 'purchase_orders_charter_id_fkey', 'charters', 'charter_id', 'id'),
  ('purchase_orders', 'purchase_orders_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('purchase_orders', 'purchase_orders_destination_location_id_fkey', 'locations', 'destination_location_id', 'id'),
  ('purchase_orders', 'purchase_orders_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('purchase_orders', 'purchase_orders_supplier_id_fkey', 'suppliers', 'supplier_id', 'id'),
  ('purchase_orders', 'purchase_orders_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('push_tokens', 'push_tokens_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('putaway_moves', 'putaway_moves_from_bin_id_fkey', 'bins', 'from_bin_id', 'id'),
  ('putaway_moves', 'putaway_moves_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('putaway_moves', 'putaway_moves_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('putaway_moves', 'putaway_moves_performed_by_fkey', 'user_profiles', 'performed_by', 'id'),
  ('putaway_moves', 'putaway_moves_to_bin_id_fkey', 'bins', 'to_bin_id', 'id'),
  ('putaway_moves', 'putaway_moves_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('receipt_line_lots', 'receipt_line_lots_receipt_line_id_fkey', 'receipt_lines', 'receipt_line_id', 'id'),
  ('receipt_lines', 'receipt_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('receipt_lines', 'receipt_lines_purchase_order_line_id_fkey', 'purchase_order_items', 'purchase_order_line_id', 'id'),
  ('receipt_lines', 'receipt_lines_receipt_id_fkey', 'receipts', 'receipt_id', 'id'),
  ('receipts', 'receipts_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('receipts', 'receipts_purchase_order_id_fkey', 'purchase_orders', 'purchase_order_id', 'id'),
  ('receipts', 'receipts_received_by_fkey', 'user_profiles', 'received_by', 'id'),
  ('receipts', 'receipts_reversed_receipt_id_fkey', 'receipts', 'reversed_receipt_id', 'id'),
  ('receipts', 'receipts_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('recurring_po_templates', 'recurring_po_templates_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('recurring_po_templates', 'recurring_po_templates_destination_location_id_fkey', 'locations', 'destination_location_id', 'id'),
  ('recurring_po_templates', 'recurring_po_templates_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('recurring_po_templates', 'recurring_po_templates_supplier_id_fkey', 'suppliers', 'supplier_id', 'id'),
  ('recurring_po_templates', 'recurring_po_templates_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('rental_lines', 'rental_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('rental_lines', 'rental_lines_rental_id_fkey', 'rentals', 'rental_id', 'id'),
  ('rentals', 'rentals_borrower_user_id_fkey', 'user_profiles', 'borrower_user_id', 'id'),
  ('rentals', 'rentals_cancelled_by_fkey', 'user_profiles', 'cancelled_by', 'id'),
  ('rentals', 'rentals_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('rentals', 'rentals_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('rentals', 'rentals_returned_by_fkey', 'user_profiles', 'returned_by', 'id'),
  ('rentals', 'rentals_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('restore_points', 'restore_points_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('restore_points', 'restore_points_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('return_decisions', 'return_decisions_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('return_decisions', 'return_decisions_line_fkey', 'return_lines', 'return_line_id,return_id', 'id,return_id'),
  ('return_decisions', 'return_decisions_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('return_decisions', 'return_decisions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('return_decisions', 'return_decisions_previous_item_id_fkey', 'inventory_items', 'previous_item_id', 'id'),
  ('return_decisions', 'return_decisions_return_fkey', 'returns', 'return_id,organization_id', 'id,organization_id'),
  ('return_lines', 'return_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('return_lines', 'return_lines_order_request_line_id_fkey', 'order_request_lines', 'order_request_line_id', 'id'),
  ('return_lines', 'return_lines_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('return_lines', 'return_lines_return_id_fkey', 'returns', 'return_id', 'id'),
  ('returns', 'returns_approved_by_fkey', 'user_profiles', 'approved_by', 'id'),
  ('returns', 'returns_closed_by_fkey', 'user_profiles', 'closed_by', 'id'),
  ('returns', 'returns_denied_by_fkey', 'user_profiles', 'denied_by', 'id'),
  ('returns', 'returns_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('returns', 'returns_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('returns', 'returns_received_by_fkey', 'user_profiles', 'received_by', 'id'),
  ('returns', 'returns_requested_by_fkey', 'user_profiles', 'requested_by', 'id'),
  ('role_permission_overrides', 'role_permission_overrides_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('role_permission_overrides', 'role_permission_overrides_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('saved_views', 'saved_views_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('saved_views', 'saved_views_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('schedule_events', 'schedule_events_bundle_id_fkey', 'bundles', 'bundle_id', 'id'),
  ('schedule_events', 'schedule_events_bundle_warehouse_id_fkey', 'warehouses', 'bundle_warehouse_id', 'id'),
  ('schedule_events', 'schedule_events_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('schedule_events', 'schedule_events_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('schedule_events', 'schedule_events_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('serial_registry', 'serial_registry_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('serial_registry', 'serial_registry_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('serial_registry', 'serial_registry_receipt_line_id_fkey', 'receipt_lines', 'receipt_line_id', 'id'),
  ('serial_registry', 'serial_registry_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('shipment_lines', 'shipment_lines_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('shipment_lines', 'shipment_lines_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('shipment_lines', 'shipment_lines_shipment_id_fkey', 'shipments', 'shipment_id', 'id'),
  ('shipments', 'shipments_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('shipments', 'shipments_destination_charter_id_fkey', 'charters', 'destination_charter_id', 'id'),
  ('shipments', 'shipments_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('shipments', 'shipments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('shipments', 'shipments_source_warehouse_id_fkey', 'warehouses', 'source_warehouse_id', 'id'),
  ('size_count_adjustments', 'size_count_adjustments_operator_id_fkey', 'user_profiles', 'operator_id', 'id'),
  ('size_count_adjustments', 'size_count_adjustments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('size_count_adjustments', 'size_count_adjustments_session_id_fkey', 'size_count_sessions', 'session_id', 'id'),
  ('size_count_events', 'size_count_events_counted_by_fkey', 'user_profiles', 'counted_by', 'id'),
  ('size_count_events', 'size_count_events_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('size_count_events', 'size_count_events_session_id_fkey', 'size_count_sessions', 'session_id', 'id'),
  ('size_count_sessions', 'size_count_sessions_canceled_by_fkey', 'user_profiles', 'canceled_by', 'id'),
  ('size_count_sessions', 'size_count_sessions_completed_by_fkey', 'user_profiles', 'completed_by', 'id'),
  ('size_count_sessions', 'size_count_sessions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('size_count_sessions', 'size_count_sessions_product_group_id_fkey', 'product_groups', 'product_group_id', 'id'),
  ('size_count_sessions', 'size_count_sessions_purchase_order_id_fkey', 'purchase_orders', 'purchase_order_id', 'id'),
  ('size_count_sessions', 'size_count_sessions_started_by_fkey', 'user_profiles', 'started_by', 'id'),
  ('size_count_sessions', 'size_count_sessions_supplier_id_fkey', 'suppliers', 'supplier_id', 'id'),
  ('size_count_sessions', 'size_count_sessions_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('size_count_training_samples', 'size_count_training_samples_captured_by_fkey', 'user_profiles', 'captured_by', 'id'),
  ('size_count_training_samples', 'size_count_training_samples_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('size_scale_values', 'size_scale_values_size_scale_id_fkey', 'size_scales', 'size_scale_id', 'id'),
  ('size_scales', 'size_scales_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('stock_movements', 'stock_movements_from_location_id_fkey', 'locations', 'from_location_id', 'id'),
  ('stock_movements', 'stock_movements_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('stock_movements', 'stock_movements_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('stock_movements', 'stock_movements_to_location_id_fkey', 'locations', 'to_location_id', 'id'),
  ('stock_movements', 'stock_movements_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('stock_reservations', 'stock_reservations_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('stock_reservations', 'stock_reservations_order_request_id_fkey', 'order_requests', 'order_request_id', 'id'),
  ('stock_reservations', 'stock_reservations_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('stock_reservations', 'stock_reservations_rental_id_fkey', 'rentals', 'rental_id', 'id'),
  ('stock_reservations', 'stock_reservations_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('suppliers', 'suppliers_deleted_by_fkey', 'user_profiles', 'deleted_by', 'id'),
  ('suppliers', 'suppliers_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('support_tickets', 'support_tickets_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('support_tickets', 'support_tickets_submitted_by_fkey', 'user_profiles', 'submitted_by', 'id'),
  ('tags', 'tags_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('tolerance_profiles', 'tolerance_profiles_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('tolerance_profiles', 'tolerance_profiles_vendor_id_fkey', 'suppliers', 'vendor_id', 'id'),
  ('uom_conversions', 'uom_conversions_approved_by_fkey', 'user_profiles', 'approved_by', 'id'),
  ('uom_conversions', 'uom_conversions_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('uom_conversions', 'uom_conversions_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('uom_conversions', 'uom_conversions_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('user_category_assignments', 'user_category_assignments_assigned_by_fkey', 'user_profiles', 'assigned_by', 'id'),
  ('user_category_assignments', 'user_category_assignments_category_id_fkey', 'categories', 'category_id', 'id'),
  ('user_category_assignments', 'user_category_assignments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('user_category_assignments', 'user_category_assignments_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('user_login_devices', 'user_login_devices_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('user_permission_overrides', 'user_permission_overrides_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('user_permission_overrides', 'user_permission_overrides_updated_by_fkey', 'user_profiles', 'updated_by', 'id'),
  ('user_permission_overrides', 'user_permission_overrides_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('user_profiles', 'user_profiles_default_organization_id_fkey', 'organizations', 'default_organization_id', 'id'),
  ('user_profiles', 'user_profiles_disabled_by_fkey', 'user_profiles', 'disabled_by', 'id'),
  ('user_warehouse_assignments', 'user_warehouse_assignments_assigned_by_fkey', 'user_profiles', 'assigned_by', 'id'),
  ('user_warehouse_assignments', 'user_warehouse_assignments_charter_id_fkey', 'charters', 'charter_id', 'id'),
  ('user_warehouse_assignments', 'user_warehouse_assignments_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('user_warehouse_assignments', 'user_warehouse_assignments_user_id_fkey', 'user_profiles', 'user_id', 'id'),
  ('user_warehouse_assignments', 'user_warehouse_assignments_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('user_warehouse_assignments', 'uwa_warehouse_charter_fk', 'warehouse_charters', 'warehouse_id,charter_id', 'warehouse_id,charter_id'),
  ('vendor_item_mappings', 'vendor_item_mappings_approved_by_fkey', 'user_profiles', 'approved_by', 'id'),
  ('vendor_item_mappings', 'vendor_item_mappings_item_id_fkey', 'inventory_items', 'item_id', 'id'),
  ('vendor_item_mappings', 'vendor_item_mappings_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('vendor_item_mappings', 'vendor_item_mappings_vendor_id_fkey', 'suppliers', 'vendor_id', 'id'),
  ('warehouse_charters', 'warehouse_charters_charter_id_fkey', 'charters', 'charter_id', 'id'),
  ('warehouse_charters', 'warehouse_charters_organization_id_fkey', 'organizations', 'organization_id', 'id'),
  ('warehouse_charters', 'warehouse_charters_warehouse_id_fkey', 'warehouses', 'warehouse_id', 'id'),
  ('warehouses', 'warehouses_created_by_fkey', 'user_profiles', 'created_by', 'id'),
  ('warehouses', 'warehouses_manager_user_id_fkey', 'user_profiles', 'manager_user_id', 'id'),
  ('warehouses', 'warehouses_organization_id_fkey', 'organizations', 'organization_id', 'id');
insert into expected_junctions (junction, a, b, a_fk, b_fk) values
  ('bundle_components', 'bundles', 'inventory_items', 'bundle_components_bundle_id_fkey', 'bundle_components_item_id_fkey'),
  ('customer_catalog', 'customers', 'inventory_items', 'customer_catalog_customer_id_fkey', 'customer_catalog_item_id_fkey'),
  ('item_tags', 'inventory_items', 'tags', 'item_tags_item_id_fkey', 'item_tags_tag_id_fkey'),
  ('order_submissions', 'organizations', 'user_profiles', 'order_submissions_organization_id_fkey', 'order_submissions_user_id_fkey'),
  ('price_list_items', 'inventory_items', 'price_lists', 'price_list_items_item_id_fkey', 'price_list_items_price_list_id_fkey'),
  ('public_link_catalog_entries', 'inventory_items', 'public_request_links', 'public_link_catalog_entries_item_id_fkey', 'public_link_catalog_entries_link_id_fkey'),
  ('user_permission_overrides', 'organizations', 'user_profiles', 'user_permission_overrides_organization_id_fkey', 'user_permission_overrides_user_id_fkey'),
  ('warehouse_charters', 'charters', 'warehouses', 'warehouse_charters_charter_id_fkey', 'warehouse_charters_warehouse_id_fkey');
insert into expected_pairs (a, b, relationships) values
  ('approvals', 'user_profiles', 'approvals_decided_by_fkey,approvals_requested_by_fkey'),
  ('bins', 'putaway_moves', 'putaway_moves_from_bin_id_fkey,putaway_moves_to_bin_id_fkey'),
  ('bundles', 'inventory_items', 'bundle_components,bundles_phantom_item_id_fkey'),
  ('bundles', 'user_profiles', 'bundles_created_by_fkey,bundles_updated_by_fkey'),
  ('cycle_count_ai_scans', 'user_profiles', 'cycle_count_ai_scans_confirmed_by_fkey,cycle_count_ai_scans_created_by_fkey'),
  ('cycle_counts', 'exception_occurrences', 'exception_occurrences_confirmed_cycle_count_id_fkey,exception_occurrences_recount_cycle_count_id_fkey'),
  ('cycle_counts', 'user_profiles', 'cycle_counts_assigned_to_fkey,cycle_counts_assignment_claimed_by_fkey,cycle_counts_canceled_by_fkey,cycle_counts_completed_by_fkey,cycle_counts_started_by_fkey'),
  ('exception_evidence', 'user_profiles', 'exception_evidence_removed_by_fkey,exception_evidence_uploaded_by_fkey'),
  ('exception_occurrences', 'user_profiles', 'exception_occurrences_acknowledged_by_fkey,exception_occurrences_confirmed_by_fkey,exception_occurrences_escalated_by_fkey,exception_occurrences_escalation_claimed_by_fkey'),
  ('inventory_items', 'po_import_lines', 'po_import_lines_item_id_fkey,po_import_lines_suggested_item_id_fkey'),
  ('inventory_items', 'return_decisions', 'return_decisions_item_id_fkey,return_decisions_previous_item_id_fkey'),
  ('inventory_items', 'user_profiles', 'inventory_items_created_by_fkey,inventory_items_deleted_by_fkey,inventory_items_updated_by_fkey'),
  ('locations', 'stock_movements', 'stock_movements_from_location_id_fkey,stock_movements_to_location_id_fkey'),
  ('order_request_lines', 'user_profiles', 'order_request_lines_packed_by_fkey,order_request_lines_picked_by_fkey'),
  ('order_requests', 'user_profiles', 'order_requests_approved_by_fkey,order_requests_assigned_delivery_by_fkey,order_requests_assigned_delivery_user_id_fkey,order_requests_assigned_picker_id_fkey,order_requests_cancelled_by_fkey,order_requests_completed_by_fkey,order_requests_in_transit_by_fkey,order_requests_packing_slip_generated_by_fkey,order_requests_pick_slip_generated_by_fkey,order_requests_picking_claimed_by_fkey,order_requests_picking_completed_by_fkey,order_requests_requester_user_id_fkey,order_requests_staged_by_fkey'),
  ('organization_members', 'user_profiles', 'organization_members_invited_by_fkey,organization_members_user_id_fkey'),
  ('organizations', 'platform_impersonation_sessions', 'platform_impersonation_sessions_previous_organization_id_fkey,platform_impersonation_sessions_target_organization_id_fkey'),
  ('organizations', 'user_profiles', 'order_submissions,user_permission_overrides,user_profiles_default_organization_id_fkey'),
  ('platform_admin_audit', 'user_profiles', 'platform_admin_audit_actor_user_id_fkey,platform_admin_audit_target_user_id_fkey'),
  ('po_imports', 'user_profiles', 'po_imports_approved_by_fkey,po_imports_uploaded_by_fkey'),
  ('procedures', 'user_profiles', 'procedures_created_by_fkey,procedures_updated_by_fkey'),
  ('product_groups', 'user_profiles', 'product_groups_created_by_fkey,product_groups_updated_by_fkey'),
  ('purchase_orders', 'user_profiles', 'purchase_orders_created_by_fkey,purchase_orders_updated_by_fkey'),
  ('recurring_po_templates', 'user_profiles', 'recurring_po_templates_created_by_fkey,recurring_po_templates_updated_by_fkey'),
  ('rentals', 'user_profiles', 'rentals_borrower_user_id_fkey,rentals_cancelled_by_fkey,rentals_created_by_fkey,rentals_returned_by_fkey'),
  ('returns', 'user_profiles', 'returns_approved_by_fkey,returns_closed_by_fkey,returns_denied_by_fkey,returns_received_by_fkey,returns_requested_by_fkey'),
  ('schedule_events', 'warehouses', 'schedule_events_bundle_warehouse_id_fkey,schedule_events_warehouse_id_fkey'),
  ('size_count_sessions', 'user_profiles', 'size_count_sessions_canceled_by_fkey,size_count_sessions_completed_by_fkey,size_count_sessions_started_by_fkey'),
  ('uom_conversions', 'user_profiles', 'uom_conversions_approved_by_fkey,uom_conversions_created_by_fkey'),
  ('user_category_assignments', 'user_profiles', 'user_category_assignments_assigned_by_fkey,user_category_assignments_user_id_fkey'),
  ('user_permission_overrides', 'user_profiles', 'user_permission_overrides_updated_by_fkey,user_permission_overrides_user_id_fkey'),
  ('user_profiles', 'user_warehouse_assignments', 'user_warehouse_assignments_assigned_by_fkey,user_warehouse_assignments_user_id_fkey'),
  ('user_profiles', 'warehouses', 'warehouses_created_by_fkey,warehouses_manager_user_id_fkey');
-- END GENERATED

-- What PostgREST reads: every foreign key between two public tables
-- (partition clones left out, as PostgREST leaves them out).
create temporary view actual_fks as
select t.relname::text as tbl,
       c.conname::text as name,
       rt.relname::text as ref_tbl,
       (select string_agg(a.attname::text, ',' order by k.ord)
          from unnest(c.conkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
       (select string_agg(a.attname::text, ',' order by k.ord)
          from unnest(c.confkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as ref_cols,
       c.conrelid,
       c.conkey
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  join pg_class rt on rt.oid = c.confrelid
  join pg_namespace rn on rn.oid = rt.relnamespace
 where c.contype = 'f'
   and c.conparentid = 0
   and n.nspname = 'public'
   and rn.nspname = 'public'
   and not t.relispartition
   and not rt.relispartition;

-- A junction: two foreign keys of one table, both inside its primary key.
-- Each unordered pair of keys is one relationship; its ends are ordered by
-- name (byte order), as the generator orders them.
create temporary view actual_junctions as
select x.tbl as junction,
       case when x.ref_tbl <= y.ref_tbl collate "C" then x.ref_tbl else y.ref_tbl end as a,
       case when x.ref_tbl <= y.ref_tbl collate "C" then y.ref_tbl else x.ref_tbl end as b,
       case when x.ref_tbl <= y.ref_tbl collate "C" then x.name else y.name end as a_fk,
       case when x.ref_tbl <= y.ref_tbl collate "C" then y.name else x.name end as b_fk
  from actual_fks x
  join actual_fks y on y.conrelid = x.conrelid and x.name < y.name collate "C"
  join pg_constraint pk on pk.conrelid = x.conrelid and pk.contype = 'p'
 where x.conkey <@ pk.conkey
   and y.conkey <@ pk.conkey;

-- Two tables joined by two or more relationships. A self-referencing key
-- alone is one relationship (PostgREST resolves `locations(...)` from
-- locations), so it never makes a pair here.
create temporary view actual_pairs as
with rels as (
  select case when tbl <= ref_tbl collate "C" then tbl else ref_tbl end as a,
         case when tbl <= ref_tbl collate "C" then ref_tbl else tbl end as b,
         name
    from actual_fks
  union all
  select a, b, junction from actual_junctions
)
select a, b, string_agg(name, ',' order by name collate "C") as relationships
  from rels
 group by a, b
having count(*) >= 2;

select set_eq(
  $$ select tbl, name, ref_tbl, cols, ref_cols from actual_fks $$,
  $$ select tbl, name, ref_tbl, cols, ref_cols from expected_fks $$,
  '1: every public foreign key is in scripts/postgrest-embeds/relationships.snapshot.json, and no other (regenerate: node scripts/gen-postgrest-embed-snapshot.mjs)'
);

select set_eq(
  $$ select junction, a, b, a_fk, b_fk from actual_junctions $$,
  $$ select junction, a, b, a_fk, b_fk from expected_junctions $$,
  '2: every junction PostgREST sees (many-to-many through a primary key) is in the snapshot, and no other'
);

select set_eq(
  $$ select a, b, relationships from actual_pairs $$,
  $$ select a, b, relationships from expected_pairs $$,
  '3: the ambiguous table pairs and their relationships are exactly the snapshot''s (each embed between them must name one)'
);

select * from finish();
rollback;
