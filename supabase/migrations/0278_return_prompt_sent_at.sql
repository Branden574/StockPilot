-- ============================================================================
-- 0278_return_prompt_sent_at.sql — idempotency marker for the return-prompt
-- email ("Need to return anything from your order?").
--
-- WHY: the self-service return link (order_requests.return_token → the public
-- /returns/request/[token] portal, 0156) used to be emailed ONLY from the
-- digital sign route. Returns-access Unit A sends it from EVERY app-side path
-- that reaches the terminal fulfilled state 'completed' — the digital sign
-- route, confirm_physical_signature (paper), and close_partial (backordered
-- closed as delivered-partial). An order can cross more than one of those
-- surfaces (sign → complete, or a route retry), so the send must be
-- idempotent: `return_prompt_sent_at` is stamped via a guarded UPDATE
-- (`... where return_prompt_sent_at is null`) BEFORE the email goes out, and
-- only the single winner of that update sends. Signed AND completed orders
-- therefore produce exactly ONE prompt.
--
-- NO BACKFILL — deliberately. Historical completed orders keep the column
-- NULL, but the app-side helper only fires on a NEW completion transition, so
-- nothing re-walks old rows and no historical requester gets spammed when
-- this ships.
--
-- SAFETY: nullable, no default, no index (always read by pk alongside the
-- rest of the order row) — a pure metadata add; a no-op against existing rows.
-- ============================================================================

alter table public.order_requests
  add column if not exists return_prompt_sent_at timestamptz;

comment on column public.order_requests.return_prompt_sent_at is
  'When the one-time "Need to return anything?" email was sent for this order. '
  'Stamped (guarded update, only-winner-sends) before the send so signed AND '
  'completed paths dedupe to a single prompt. NULL = never sent (incl. all '
  'orders completed before 0278 — no backfill, no historical spam).';
