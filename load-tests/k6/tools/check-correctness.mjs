#!/usr/bin/env node
// After a run: is the data still right? LOCAL ONLY.
//
//   node load-tests/k6/tools/check-correctness.mjs --manifest <m.json> --summary <k6 summary.json> \
//        --since <ISO time the run began, from the database clock> [--out result.json]
//
// Checks, for the load-test organization:
//   1. on hand = the sum of its holdings, for every item a movement touched
//      since the run began (and, cheaply, for every item of the organization);
//   2. no negative holding and no negative on hand;
//   3. orders created since the run began = the number of 201 answers
//      (orders_created), one order per submission key, every placed
//      submission pointing at an order;
//   4. receipts since the run began = the receipts answered (receipts_created),
//      no idempotency key used by two receipts, one receipt line and one
//      receive movement per receipt; every purchase order line's received
//      quantity = the accepted quantity of its receipt lines (post_receipt_v2
//      writes the receive movement through adjust_stock with the receipt id
//      in its notes);
//   5. adjust movements by the load-test accounts since the run began = the
//      200 answers (adjust_up_ok + adjust_down_ok), and their net change =
//      up - down.
// Writes the run's end cut off (sent, never answered: k6 stops a request still
// in flight when gracefulStop runs out) may or may not have been committed. For
// those the counts in 3-5 may be higher than the answers, by at most the
// unanswered writes of that kind (writes_sent - writes_answered), and the
// result names how many there were. Run this after the database has gone
// quiet (run-scale.mjs waits for it), or a write still being committed counts
// as a fault.
// Exits 1 when any check fails.
import { writeFileSync } from 'node:fs';

import { lit, parseArgs, psqlJson, readJson } from './local.mjs';

function counter(summary, name) {
  const m = summary.metrics[name];
  return m ? Number(m.values.count || 0) : 0;
}

/** Sent and never answered, for one counted write (see workload.js COUNTED_WRITES). */
function unanswered(summary, write) {
  return Math.max(
    0,
    counter(summary, `writes_sent{write:${write}}`) -
      counter(summary, `writes_answered{write:${write}}`),
  );
}

/** answers <= database <= answers + cut off, with the words for the result. */
function within(database, answers, cutOff) {
  const d = Number(database);
  return [
    d >= answers && d <= answers + cutOff,
    `database ${database}, answers ${answers}${cutOff ? `, cut off unanswered ${cutOff}` : ''}`,
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const m = readJson(args.manifest);
  const summary = readJson(args.summary);
  const since = args.since;
  if (!since || Number.isNaN(Date.parse(since))) throw new Error('--since <ISO time> is required');
  const org = lit(m.organizationId);
  const users = Object.values(m.users)
    .flat()
    .map((u) => lit(u.id))
    .join(',');
  const t = lit(since);

  const db = psqlJson(`
with touched as (
  select distinct item_id from public.stock_movements
   where organization_id = ${org} and created_at >= ${t}::timestamptz
), held as (
  select i.id, i.quantity_on_hand, coalesce(sum(s.quantity), 0) as held
    from public.inventory_items i
    left join public.item_stock_levels s on s.item_id = i.id
   where i.organization_id = ${org}
   group by i.id, i.quantity_on_hand
)
select json_build_object(
  'touchedItems', (select count(*) from touched),
  'touchedMismatch', (select count(*) from held h join touched x on x.item_id = h.id where h.quantity_on_hand <> h.held),
  'allMismatch', (select count(*) from held where quantity_on_hand <> held),
  'negativeHoldings', (select count(*) from public.item_stock_levels where organization_id = ${org} and quantity < 0),
  'negativeOnHand', (select count(*) from public.inventory_items where organization_id = ${org} and quantity_on_hand < 0),
  'ordersSince', (select count(*) from public.order_requests where organization_id = ${org} and created_at >= ${t}::timestamptz),
  'placedSubmissionsSince', (select count(*) from public.order_submissions
                              where organization_id = ${org} and outcome = 'placed' and created_at >= ${t}::timestamptz),
  'submissionKeysWithTwoOrders', (select count(*) from (select key from public.order_submissions
                              where organization_id = ${org} and order_request_id is not null
                              group by key having count(distinct order_request_id) > 1) d),
  'ordersWithTwoSubmissions', (select count(*) from (select order_request_id from public.order_submissions
                              where organization_id = ${org} and order_request_id is not null
                              group by order_request_id having count(*) > 1) d),
  'placedWithoutOrder', (select count(*) from public.order_submissions s
                              where s.organization_id = ${org} and s.outcome = 'placed'
                                and not exists (select 1 from public.order_requests o where o.id = s.order_request_id)),
  'receiptsSince', (select count(*) from public.receipts where organization_id = ${org} and created_at >= ${t}::timestamptz),
  'receiptKeysTwice', (select count(*) from (select idempotency_key from public.receipts
                              where organization_id = ${org} group by purchase_order_id, idempotency_key having count(*) > 1) d),
  'receiptsLineCountNotOne', (select count(*) from (select r.id from public.receipts r
                              left join public.receipt_lines l on l.receipt_id = r.id
                              where r.organization_id = ${org} and r.created_at >= ${t}::timestamptz
                              group by r.id having count(l.id) <> 1) d),
  'receiptsMovementCountNotOne', (select count(*) from (select r.id from public.receipts r
                              left join public.stock_movements sm on sm.organization_id = r.organization_id
                                   and sm.movement_type = 'receive_po' and sm.notes = r.id::text
                              where r.organization_id = ${org} and r.created_at >= ${t}::timestamptz
                              group by r.id having count(sm.id) <> 1) d),
  'poLinesReceivedMismatch', (select count(*) from public.purchase_order_items p
                              where p.organization_id = ${org}
                                and p.quantity_received <> coalesce((select sum(l.qty_accepted_base) from public.receipt_lines l
                                                                      where l.purchase_order_line_id = p.id), 0)),
  'adjustMovementsSince', (select count(*) from public.stock_movements
                              where organization_id = ${org} and created_at >= ${t}::timestamptz
                                and user_id in (${users}) and movement_type in ('add', 'remove', 'adjust')),
  'adjustNetSince', (select coalesce(sum(quantity_change), 0) from public.stock_movements
                              where organization_id = ${org} and created_at >= ${t}::timestamptz
                                and user_id in (${users}) and movement_type in ('add', 'remove', 'adjust')),
  'movementTypesSince', (select coalesce(json_object_agg(movement_type, n), '{}') from (
                              select movement_type, count(*) n from public.stock_movements
                               where organization_id = ${org} and created_at >= ${t}::timestamptz group by 1) mt)
);`);

  const k6 = {
    ordersCreated: counter(summary, 'orders_created'),
    receiptsCreated: counter(summary, 'receipts_created'),
    adjustUp: counter(summary, 'adjust_up_ok'),
    adjustDown: counter(summary, 'adjust_down_ok'),
  };
  const cut = {
    placeOrder: unanswered(summary, 'place_order'),
    adjustUp: unanswered(summary, 'adjust_up'),
    adjustDown: unanswered(summary, 'adjust_down'),
    receiveLine: unanswered(summary, 'receive_line'),
  };
  const [ordersOk, ordersDetail] = within(db.ordersSince, k6.ordersCreated, cut.placeOrder);
  const [receiptsOk, receiptsDetail] = within(
    db.receiptsSince,
    k6.receiptsCreated,
    cut.receiveLine,
  );
  const [adjustOk, adjustDetail] = within(
    db.adjustMovementsSince,
    k6.adjustUp + k6.adjustDown,
    cut.adjustUp + cut.adjustDown,
  );
  // Each adjust moves one unit: a cut-off +1 may add one, a cut-off -1 take one.
  const net = Number(db.adjustNetSince);
  const answeredNet = k6.adjustUp - k6.adjustDown;
  const netOk = net >= answeredNet - cut.adjustDown && net <= answeredNet + cut.adjustUp;
  const checks = [
    [
      'on hand = sum of holdings (items touched this run)',
      db.touchedMismatch === 0,
      `${db.touchedMismatch} of ${db.touchedItems} differ`,
    ],
    ['on hand = sum of holdings (every item)', db.allMismatch === 0, `${db.allMismatch} differ`],
    ['no negative holding', db.negativeHoldings === 0, `${db.negativeHoldings}`],
    ['no negative on hand', db.negativeOnHand === 0, `${db.negativeOnHand}`],
    ['orders created = 201 answers', ordersOk, ordersDetail],
    [
      'placed submissions = orders created',
      db.placedSubmissionsSince === db.ordersSince,
      `${db.placedSubmissionsSince} vs ${db.ordersSince}`,
    ],
    [
      'one order per submission key',
      db.submissionKeysWithTwoOrders === 0 && db.ordersWithTwoSubmissions === 0,
      `${db.submissionKeysWithTwoOrders} keys with two orders, ${db.ordersWithTwoSubmissions} orders with two submissions`,
    ],
    [
      'every placed submission has its order',
      db.placedWithoutOrder === 0,
      `${db.placedWithoutOrder}`,
    ],
    ['receipts = receive answers', receiptsOk, receiptsDetail],
    ['no idempotency key on two receipts', db.receiptKeysTwice === 0, `${db.receiptKeysTwice}`],
    ['one line per receipt', db.receiptsLineCountNotOne === 0, `${db.receiptsLineCountNotOne}`],
    [
      'one receive movement per receipt',
      db.receiptsMovementCountNotOne === 0,
      `${db.receiptsMovementCountNotOne}`,
    ],
    [
      'purchase order received = receipt lines',
      db.poLinesReceivedMismatch === 0,
      `${db.poLinesReceivedMismatch} lines differ`,
    ],
    ['adjust movements = adjust answers', adjustOk, adjustDetail],
    [
      'adjust net change = up - down',
      netOk,
      `database ${net}, answers ${answeredNet}${cut.adjustUp + cut.adjustDown ? ` (cut off: +1 x ${cut.adjustUp}, -1 x ${cut.adjustDown})` : ''}`,
    ],
  ];
  const ok = checks.every((c) => c[1]);
  const result = {
    ok,
    since,
    checks: checks.map(([name, pass, detail]) => ({ name, pass, detail })),
    database: db,
    answers: k6,
    unansweredWrites: cut,
  };
  for (const c of result.checks)
    console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name} (${c.detail})`);
  const cutTotal = Object.values(cut).reduce((a, b) => a + b, 0);
  console.log(`  unanswered writes (cut off at the end): ${cutTotal}`);
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 1));
  if (!ok) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  console.error(`[correctness] ${e.message}`);
  process.exit(1);
}
