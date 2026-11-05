import { Package, Truck } from 'lucide-react';
import Link from 'next/link';
import { deliveryDriverLabel, formatOrderNumber, RETURNS_COPY } from '@stockpilot/core';

import { OrderStatusBadge } from '@/components/orders/status-badge';
import { summaryRequesterLabel } from '@/components/orders/requester-label';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { Badge } from '@/components/ui/badge';
import { formatNumber, formatRelative } from '@/lib/utils';
import type { OrderRequestSummary } from '@/server/services/order-requests';

/**
 * The Orders list as cards, the way Liquid Glass draws it on a phone
 * (Orders.dc.html, its `.mob-f` section at 760 px and under: "Tables become
 * cards on phones"). Glass-only and stateless: each card is one link to the
 * row's own order page (the table row's order number and requester link go
 * there too, behind the same page gate), and it prints every column the
 * table prints, so no column is lost at that width: order number, status
 * (with an exchange's state), requester, warehouse, type, lines, total
 * quantity, picker, driver, requested and last update.
 *
 * styles/liquid-glass/pages/orders.css shows it only under the glass root at
 * 760 px and under (the table is hidden there); visibility.css hides it in
 * Classic, and under the `off` rollout it is not rendered at all, so the
 * classic page is byte for byte today's. It reads nothing: the rows are the
 * ones the page already loaded. Listed in
 * tests/e2e/appearance/glass-only-allowlist.json ("duplicate action").
 */
export function OrderPhoneCards({ rows }: { rows: OrderRequestSummary[] }) {
  if (liquidGlassRollout() === 'off' || rows.length === 0) return null;
  return (
    <ul data-glass-only="" data-glass="orders-phone-cards" aria-labelledby="orders-title">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/dashboard/orders/${r.id}`} data-glass="orders-phone-card">
            <span data-glass="orders-phone-card-top">
              <span data-glass="orders-phone-card-ref">
                {formatOrderNumber(r.orderNumber) ?? '—'}
              </span>
              <span data-glass="orders-phone-card-status">
                <OrderStatusBadge status={r.status} fulfillmentType={r.fulfillmentType} />
                {r.replacementForReturnId ? (
                  <Badge variant="outline">{RETURNS_COPY.typeExchange}</Badge>
                ) : null}
              </span>
            </span>
            <RequesterLines row={r} />
            <span data-glass="orders-phone-card-facts">
              <span data-glass="orders-phone-card-type">
                {r.fulfillmentType === 'pickup' ? (
                  <Package aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <Truck aria-hidden className="size-3.5 shrink-0" />
                )}
                {r.fulfillmentType === 'pickup' ? 'Pickup' : 'Delivery'}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {formatNumber(r.lineCount)} {r.lineCount === 1 ? 'line' : 'lines'} ·{' '}
                {formatNumber(r.totalQuantity)} {r.totalQuantity === 1 ? 'unit' : 'units'}
              </span>
              <span data-glass="orders-phone-card-updated">{formatRelative(r.updatedAt)}</span>
            </span>
            <span data-glass="orders-phone-card-people">
              {r.warehouseName ?? '—'} · Picker {r.assignedPickerName ?? '—'} · Driver{' '}
              {deliveryDriverLabel({
                fulfillmentType: r.fulfillmentType,
                inTransitAt: r.inTransitAt,
                assignedDeliveryUserId: r.assignedDeliveryUserId,
                driverName: r.assignedDeliveryUserName,
              }) ?? '—'}{' '}
              · Requested {formatRelative(r.createdAt)}
            </span>
            {r.replacementForReturnId && r.exchange?.state ? (
              <span data-glass="orders-phone-card-note">{r.exchange.state}</span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The requester as the table's RequesterLabel draws it: the name, then the organisation. */
function RequesterLines({ row }: { row: OrderRequestSummary }) {
  const label = summaryRequesterLabel(row);
  const name = row.requesterName;
  const org = row.requesterOrgLabel;
  const twoLines = Boolean(name && org && label === `${name} · ${org}`);
  return (
    <span data-glass="orders-phone-card-who">
      <span data-glass="orders-phone-card-name">
        {twoLines ? name : label}
        {row.source === 'public_link' ? <Badge variant="outline">Public</Badge> : null}
      </span>
      {twoLines ? <span data-glass="orders-phone-card-org">{org}</span> : null}
    </span>
  );
}
