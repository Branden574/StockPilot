'use client';

import { Mail } from 'lucide-react';
import * as React from 'react';

import type { OrgEmailRoutingRecipientsDto } from '@stockpilot/core';

import DeliveryRequestAction from '@/components/orders/storefront/delivery-request-action';
import type { DeliveryRequestInput } from '@/components/orders/storefront/storefront-logic';
import type { StorefrontCharter } from '@/components/orders/v2/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import '@/components/orders/storefront/storefront.css';

/** One order line, flattened to exactly what the assistant's draft needs.
 *  Plain objects only — this crosses the RSC boundary from the order detail
 *  page (a server component), so the `Map` the assistant's `itemMap` input
 *  wants is rebuilt client-side below. */
export interface DeliveryRequestLine {
  itemId: string;
  quantity: number;
  name: string;
  sku: string;
}

export interface SendDeliveryRequestButtonProps {
  /**
   * The org's resolved delivery-request routing (per-org email routing,
   * migration 0337) as plain strings — the page only renders this button
   * when a routable pair exists, and `DeliveryRequestAction` re-brands
   * through the validating factory at its own seam.
   */
  recipients: OrgEmailRoutingRecipientsDto;
  orderId: string;
  orderNumber: number | null;
  warehouseName: string;
  /** The order's delivery site (charters row), null for legacy rows with no
   *  charter — same nullability the storefront dialog tolerates. */
  destination: StorefrontCharter | null;
  requestedFor: string;
  requesterEmail: string | null;
  /** `order_requests.needed_by` ISO instant, or '' when unset. The builder
   *  runs it through `new Date(...)` and prints it in `orgTimezone`, so an
   *  ISO string is as valid here as the storefront's datetime-local value. */
  neededBy: string;
  orgTimezone: string;
  notes: string;
  lines: DeliveryRequestLine[];
}

/**
 * Durable re-entry to the delivery-request assistant (owner ask 2026-08-12).
 *
 * The assistant shipped (PR #51) with exactly one entry point: the
 * post-placement success screen's "Email delivery request" button. Dismiss
 * that dialog and there was no way back — this button, on the order detail
 * page's secondary-actions row, is the way back for DELIVERY orders.
 *
 * It reuses `DeliveryRequestAction` — the SAME component the success screen
 * mounts — verbatim, hosted in a shadcn Dialog. All of that component's
 * hard-won behavior (window.open in the click's own tick, the
 * opener-severing instead of 'noopener', the mailto: one-shot fallback, the
 * '+'-safe encoding in storefront-logic) rides along untouched; this file
 * adds ONLY the trigger and the host surface. The `sp-storefront` class on
 * the wrapper div scopes the assistant's sf-* styles, which storefront.css
 * defines under that ancestor only.
 */
/**
 * WEB'S HALF of the order-row -> draft-input mapping, as a pure function.
 *
 * Extracted from the memo below on 2026-08-13 so that the cross-surface parity
 * test can drive it. `delivery-request-parity.test.tsx` renders the real order
 * page, captures the props it derives, runs them through THIS, and compares the
 * result field by field against core's `buildDeliveryRequestInput` — the
 * mapping the phone runs — for the same database row. That comparison is only
 * possible because both halves are callable outside React; while this lived
 * inside a `useMemo`, the only test that claimed to check parity was in the
 * mobile suite comparing core against core, and it could not see either of the
 * two divergences that had already reached the branch.
 *
 * The mapping is unchanged by the extraction; it is the same expression the
 * memo evaluated.
 */
export function deliveryRequestInputFromProps(
  props: SendDeliveryRequestButtonProps,
): DeliveryRequestInput {
  const { lines } = props;
  return {
    orderId: props.orderId,
    orderNumber: props.orderNumber,
    // The page only renders this button for delivery orders; the literal
    // (rather than a prop) keeps a future pickup caller from quietly
    // producing a destination-less "delivery" draft.
    fulfillmentType: 'delivery',
    warehouseName: props.warehouseName,
    destination: props.destination,
    requestedFor: props.requestedFor,
    requesterEmail: props.requesterEmail,
    neededByLocal: props.neededBy,
    orgTimezone: props.orgTimezone,
    notes: props.notes,
    lines: lines.map(({ itemId, quantity }) => ({ itemId, quantity })),
    itemMap: new Map(lines.map((l) => [l.itemId, { name: l.name, sku: l.sku }])),
  };
}

export function SendDeliveryRequestButton(props: SendDeliveryRequestButtonProps) {
  const {
    recipients,
    orderId,
    orderNumber,
    warehouseName,
    destination,
    requestedFor,
    requesterEmail,
    neededBy,
    orgTimezone,
    notes,
    lines,
  } = props;

  const input = React.useMemo<DeliveryRequestInput>(
    () =>
      deliveryRequestInputFromProps({
        recipients,
        orderId,
        orderNumber,
        warehouseName,
        destination,
        requestedFor,
        requesterEmail,
        neededBy,
        orgTimezone,
        notes,
        lines,
      }),
    [
      recipients,
      orderId,
      orderNumber,
      warehouseName,
      destination,
      requestedFor,
      requesterEmail,
      neededBy,
      orgTimezone,
      notes,
      lines,
    ],
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Mail className="h-3.5 w-3.5" />
          Send delivery request
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send delivery request</DialogTitle>
          <DialogDescription>
            The same email assistant offered when this order was placed. It opens a
            prefilled draft in your mail client — nothing is sent until you press Send
            yourself.
          </DialogDescription>
        </DialogHeader>
        {/* sp-storefront scopes the assistant's sf-* classes; flex-wrap puts
            its two inline-flex buttons on one row while the sf-note
            paragraphs (flex-basis: 100%) each take their own line, matching
            how the success screen's `.acts` flex row lays them out. */}
        <div className="sp-storefront flex flex-wrap items-center gap-2">
          <DeliveryRequestAction input={input} recipients={recipients} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
