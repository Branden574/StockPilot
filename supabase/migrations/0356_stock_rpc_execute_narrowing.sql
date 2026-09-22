-- 0356_stock_rpc_execute_narrowing.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Two EXECUTE narrowings on functions that write the stock ledger, each
-- removing a grant from a role with no legitimate caller:
--
--   1. post_shipment_shipped(uuid): closed to anon, authenticated AND PUBLIC.
--      Nothing legitimate has called it since the Shipments feature was
--      removed in May 2026.
--   2. Five SECURITY INVOKER stock RPCs the app calls as the signed-in user
--      (transfer_stock, post_receipt_v2, reverse_receipt, assemble_bundle,
--      distribute_bundle): anon and PUBLIC closed, authenticated kept.
--      Section 2 below has the evidence.
--
-- ── 1. post_shipment_shipped ────────────────────────────────────────────────
--
-- WHAT THE LIVE CATALOG SAYS (read-only catalog queries, 2026-09-22):
--   proacl    = {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
--   prosecdef = false (SECURITY INVOKER), search_path pinned, body
--               identical to 0073 (its last CREATE OR REPLACE).
--   So any signed-in user, and anon (by its own grant and through PUBLIC),
--   can reach it at POST /rest/v1/rpc/post_shipment_shipped, outside every
--   server route.
--
-- WHAT IT DOES WHEN CALLED: locks a shipments row, refuses anything but
-- status 'draft', gates on has_org_role(org, 'manager'), then runs
-- adjust_stock(item, -qty_shipped, 'transfer', null, 'Shipment <WO#>') for
-- every shipment_lines row, tries to release the linked order's
-- stock_reservations, and flips the shipment to 'shipped'.
--
-- WHY NO LEGITIMATE CALLER EXISTS:
--   * Commit 98c65656 (2026-05-21, "remove deprecated shipments feature
--     end-to-end") deleted ShipmentsService.markShipped, its only caller,
--     after 0114 had already made the surface read-only. On 2026-09-22 there
--     is no reference in apps/web, apps/mobile or packages.
--   * The live catalog has no SQL function, RLS policy or cron job that
--     references it (prosrc, pg_policies and cron.job scanned the same day).
--   * The live table holds 9 shipments (2 cancelled, 3 shipped, 4 delivered)
--     and none in 'draft'. The last shipments write, and the last
--     'Shipment ...' stock movement, were both on 2026-05-15. Every real
--     shipment therefore fails the draft check: no call any flow could make
--     today succeeds.
--
-- WHY IT STILL MATTERS: the one way left to make it write is to INSERT a
-- draft shipment and its lines through PostgREST first (0067 granted DML on
-- both tables to authenticated and the manager write policies still stand),
-- then call this RPC. No app performs that sequence, so any such call is
-- someone driving the database directly, into code nobody has maintained
-- since 0073. Evidence it is unmaintained: its 0073 reservation release
-- updates nothing for a signed-in caller, because stock_reservations_no_update
-- (USING false) hides every row from authenticated, so the "released" holds
-- silently stay held.
--
-- WHAT THIS CHANGES: EXECUTE is revoked from public, anon and authenticated,
-- and restated for service_role, the 0329 Group 3c idiom for orphaned RPCs
-- (generate_sku, log_audit). The body, the owner and the deprecated tables
-- are untouched, and historical shipment rows stay readable. service_role
-- keeps EXECUTE only as the ops path. It cannot post a shipment either: under
-- service_role auth.uid() is null, has_org_role returns false, and the body
-- raises 'forbidden'. If the RPC is ever wired back into an app, grant it
-- deliberately and give it a pgTAP test first.
--
-- pgTAP asserts the closed grants through the catalog only
-- (supabase/tests/0356_stock_rpc_execute_narrowing.test.sql). Calling a
-- function the caller lacks EXECUTE on, under a supautils hint role,
-- segfaulted Postgres images before 17.6.1.155, and CI may still pin one.
--
-- Idempotent: REVOKE of an absent privilege and GRANT of a held one are
-- no-ops.
--
-- ROLLBACK (manual, for reference; do not ship):
--   grant execute on function public.post_shipment_shipped(uuid) to authenticated;
--   grant execute on function public.<each section-2 fn>(<args>) to anon;
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function public.post_shipment_shipped(uuid) from public, anon, authenticated;
grant  execute on function public.post_shipment_shipped(uuid) to service_role;

-- ── 2. anon off the five SECURITY INVOKER stock RPCs ────────────────────────
-- The same census query that surfaced post_shipment_shipped (every public
-- function authenticated can EXECUTE whose body writes inventory_items,
-- item_stock_levels, stock_movements or stock_reservations, or calls
-- adjust_stock / apply_level_delta / transfer_stock) found 24 functions on
-- 2026-09-22. It sorts them this way:
--
--   * 11 SECURITY DEFINER (apply_cycle_count_location_delta, apply_level_delta,
--     approve_order_request, approve_partial, cancel_order_request,
--     close_partial, complete_picking, edit_movement_note,
--     process_return_disposition, reopen_picking, resume_fulfillment). None is
--     anon-EXECUTE, and each gates in its body on has_org_role and/or
--     has_permission. security_invariants INV-25/26 (0346) already require
--     that of every authenticated-EXECUTE definer. NOT touched: every one
--     except the two internal helpers has an app caller through the
--     user-authed ctx.supabase client, and 0331 and 0346 document why the two
--     helpers keep authenticated.
--   * 7 SECURITY INVOKER with anon already closed (adjust_stock,
--     post_cycle_count, duplicate_inventory_item, inventory_set_*). NOT
--     touched.
--   * post_shipment_shipped: section 1.
--   * 5 SECURITY INVOKER that still carry the Supabase default grant,
--     {=X, anon=X, authenticated=X, service_role=X}, because 0329's anon sweep
--     listed adjust_stock and post_cycle_count but not these five:
--     transfer_stock, post_receipt_v2, reverse_receipt, assemble_bundle,
--     distribute_bundle.
--
-- Section 2 does not close an exploit. An anon call has auth.uid() null, so
-- every body's first gate, has_org_role (staff for transfer_stock, manager
-- for the other four), is false and raises 'forbidden'. As INVOKER functions
-- they also run under RLS, and the write policies on inventory_items,
-- item_stock_levels and stock_movements are all scoped TO authenticated. What
-- it removes is a stock-writing surface the public key has no reason to
-- reach, as 0329 did for adjust_stock. Caller audit, 2026-09-22: each has
-- exactly one app call site, all through the user-authed ctx.supabase client
-- (InventoryService.transferStock, ReceivingService.postReceipt and
-- .reverseReceipt, BundlesService.assemble and .distribute), so each runs as
-- authenticated. The cron routes that build an admin-client context run as
-- service_role, which this does not touch. No live SQL function or RLS policy
-- references any of them, and none is overloaded.
--
-- authenticated is revoked and granted back explicitly (the 0329 3a/3b
-- idiom): the grant states the intended end state and does not rely on the
-- surviving privilege being a direct grant. service_role is untouched and
-- keeps its direct grant.

revoke execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text)                     from public, anon, authenticated;
grant  execute on function public.transfer_stock(uuid, uuid, uuid, numeric, text)                     to authenticated;

revoke execute on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)                from public, anon, authenticated;
grant  execute on function public.post_receipt_v2(uuid, uuid, jsonb, text, text, text)                to authenticated;

revoke execute on function public.reverse_receipt(uuid, text)                                        from public, anon, authenticated;
grant  execute on function public.reverse_receipt(uuid, text)                                        to authenticated;

revoke execute on function public.assemble_bundle(uuid, numeric, uuid, text)                         from public, anon, authenticated;
grant  execute on function public.assemble_bundle(uuid, numeric, uuid, text)                         to authenticated;

revoke execute on function public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text) from public, anon, authenticated;
grant  execute on function public.distribute_bundle(uuid, numeric, uuid, boolean, uuid, text, text) to authenticated;
