# Returns access everywhere (email-on-completion + portal + mobile staff)

> Execute: 3 parallel worktree units (A email/tracking, B portal, C mobile+API), integrate sequentially (A then B then C), 3-lens adversarial review, ship + OTA. Base: main @ e7a6d4c5.

**Owner (2026-07-20):** close all three returns-access gaps: (1) the self-serve return link only reaches requesters whose order was SIGNED (sign-route email); orders completed without signature never get it; (2) B2B portal customers have no in-portal "Request a return"; (3) mobile staff can't create returns.

**Current verified machinery (REUSE, do not fork):** `RMAService.createFromOrder` (staff path, asserts returns permission) + `createRequesterReturn` (public path: token → order, line-belonging + durable returned_quantity budget, source='requester', status='requested', staff approval queue; no inventory movement until approve→receive→close). Public page `/returns/request/[token]`; email builder lives inline in `/api/orders/sign/route.ts` (sendEmail → Resend). `order_requests.return_token` (mig 0156).

## Unit A — return link on EVERY completed order + tracking page
1. **Mig 0278**: `order_requests.return_prompt_sent_at timestamptz` (idempotency marker; header comment). No backfill (past orders: don't spam).
2. Extract the sign-route's return-prompt email (subject "Need to return anything from your order?", `/returns/request/<token>` link) into a shared helper (e.g. `server/email/return-prompt.ts`); sign route uses it.
3. Send on COMPLETION without signature: find the transition(s) to completed/delivered (order actions/RPC callers) and, app-side + best-effort (audit/email pattern: never fail the transition), send when: order reaches a terminal fulfilled state AND requester_email present AND fulfilled qty > 0 AND `return_prompt_sent_at is null` → set marker (both paths: sign route sets it too → no double-email).
4. Order-TRACKING page (public token page, if present — verify path) + requester-visible order detail: once completed with fulfilled lines, show "Request a return" linking to `/returns/request/<token>`.
5. pgTAP for 0278 (column) + unit tests: dedupe (marker), no-email-at-zero-fulfilled, sign+complete = one email.

## Unit B — B2B portal "Request a return"
1. Portal order detail (server-mediated /portal, customer principal — NEVER org_members): completed orders with returnable lines get "Request a return" → in-portal form (lines + qty + reason) → portal server action.
2. The action resolves the CUSTOMER'S OWN order server-side (accepted-mapping-wins posture; no cross-customer access), then reuses the requester-return creation semantics (same budget/validation — call the shared service path with the order resolved internally; do NOT re-implement). Portal-appropriate rate limit. source='requester'.
3. Confirmation state in-portal ("requested — pending approval") + the return visible on that order's portal view (status only; no staff data).
4. Tests: cross-customer order id → not_found; over-budget line rejected; happy path lands status='requested' + queue-visible; unauthenticated portal → denied.

## Unit C — mobile staff return-creation (+ Bearer API)
1. **Pinned contract:** `POST /api/v1/orders/[id]/returns` — body `{ reasonCode?, notes?, lines: [{orderRequestLineId, quantity, disposition:'restock'|'scrap'}] }` → `{ ok: true, return: {...createFromOrder result} }`. withApiContext→401; SAME permission assert as the web action (read RMAService.createFromOrder and mirror); rate limit 30/min/user; 404 foreign org; 400 validation; ServiceError mapping per repo convention.
2. Mobile `app/order/[id].tsx`: staff with the returns permission (effective-permissions gate) see "Create return" on completed/delivered orders with returnable lines (fulfilled − returned > 0 — compute from the order lines the screen already loads, mirroring web's returnableLines). Sheet: per-line qty steppers + reason + per-line disposition → POST → success Alert + refresh. 4xx message surfaces inline.
3. Tests: pure helper (returnableLines budget math, payload builder) + route tests (401/403/404/400/happy incl. service-args assert).

## Global constraints
- Returns semantics untouched: approval queue flow, budgets, dispositions, no inventory movement before approve/receive. NO changes to RMAService state machine.
- Public/portal surfaces: fail-closed rate limits, no cross-tenant/cross-customer leaks, no staff-only data in portal/public payloads.
- Mig 0278 applied to prod BEFORE deploy (assistant, `supabase db push --linked`). OTA after merge. NO Claude/Anthropic co-author trailers. Live-verify: web email dedupe via marker in Demo Co; portal request lands in staff queue; mobile create-return round-trip on sim (screenshot).
