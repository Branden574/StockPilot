import { Package, Truck } from 'lucide-react';

import { liquidGlassRollout } from '@/components/theme/appearance-flag';

/**
 * The order's fulfilment beside its status in the page head, the way Liquid
 * Glass draws it (Order-Detail.dc.html: an outline badge with a truck and
 * "Delivery"; a box and "Pickup" for the other type, as the Orders list's
 * Type column shows it). Glass-only words and a decorative icon: no link,
 * button or field, so it adds no action (glass-only-allowlist.json,
 * "decoration (no action)"). It reads nothing new: the type is the order's
 * own fulfillment_type, which the page already loaded.
 *
 * Hidden in Classic by styles/liquid-glass/visibility.css and not rendered
 * at all under the `off` rollout, so the classic page is today's. Styled by
 * styles/liquid-glass/pages/order-detail.css.
 *
 * Where it sits: in the head's title row, between the title (h1) and the
 * status (the title aside span), as a <div>. A hidden glass-only element
 * still counts for :first-child, :last-child, :only-child and :empty, so it
 * goes where it changes none of those for a Classic element: after the
 * status it took the status badge's :last-child and :only-child (and the
 * aside's :empty where the status renders nothing), and as a span it would
 * take the aside span's :first-of-type. Glass draws it after the status
 * (order-detail.css gives it `order: 1` in the flex row), as the board does;
 * it holds no control, so the keyboard order is untouched.
 */
export function OrderFulfilmentBadge({
  fulfillmentType,
}: {
  fulfillmentType: string | null | undefined;
}) {
  if (liquidGlassRollout() === 'off') return null;
  if (fulfillmentType !== 'pickup' && fulfillmentType !== 'delivery') return null;
  const Icon = fulfillmentType === 'delivery' ? Truck : Package;
  return (
    <div data-glass-only="" data-glass="order-fulfilment">
      <Icon aria-hidden="true" />
      {fulfillmentType === 'delivery' ? 'Delivery' : 'Pickup'}
    </div>
  );
}
