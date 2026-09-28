/**
 * CAUGHT BEFORE IT LEAVES, ON THE PHONE (F2-2, the SO-000100 slice).
 *
 * SO-000100 went out for delivery two minutes after its pick completed with
 * the pen line at 0 of 60, and nothing on screen said so. Before the order is
 * staged, sent out for delivery, or signed for (Collect signature, Physical
 * signature), the phone now asks when some line has units nobody picked:
 * core's describeDepartureRisk, the same words and the same rule as the web
 * page. UI only (F2 decision D17): the server stays permissive, because
 * shipping short is legitimate (the backorder model).
 *
 * The confirm points to the line rather than carrying fixes of its own
 * (decision D18): "Fix the order" opens the first short line, where Remove and
 * "Lower to what was picked" are. Once the order is out for delivery its lines
 * are final, and the button is "Go back".
 *
 * Pure: no React Native import. The screen hands `Alert.alert` the title, the
 * message and the buttons built here.
 */

import { describeDepartureRisk, type DepartureAction, type DepartureRisk } from '@stockpilot/core';

/** The order-screen line fields the confirm reads. `picked` is
 *  quantity_picked, normalised to 0 (NULL until a picker saves anything). */
export interface DepartureOrderLine {
  orderRequestLineId: string | null;
  name: string;
  requested: number;
  fulfilled: number;
  picked: number;
}

/**
 * The confirm before `action`, or null when nothing is short (core's rule:
 * a settled pick at an open status with units nobody picked). Null at a
 * shortfall of 0, so the common case gains no friction.
 */
export function orderDepartureRisk(
  order: { status: string; lines: readonly DepartureOrderLine[] },
  action: DepartureAction,
): DepartureRisk | null {
  return describeDepartureRisk({
    status: order.status,
    action,
    lines: order.lines.map((l) => ({
      lineId: l.orderRequestLineId,
      itemName: l.name,
      quantityRequested: l.requested,
      quantityFulfilled: l.fulfilled,
      quantityPicked: l.picked,
    })),
  });
}

/** An `Alert.alert` button (react-native's AlertButton, without importing it). */
export interface ConfirmButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

/**
 * The confirm's two buttons: go back to the order (the cancel button, so the
 * safe choice is the default one), then go ahead. Going back hands the first
 * short line to `onFix` so the screen can open it; once the lines are final
 * ("Go back") there is nothing to open and it hands null.
 */
export function departureConfirmButtons(
  risk: DepartureRisk,
  handlers: { onFix: (lineId: string | null) => void; onProceed: () => void },
): ConfirmButton[] {
  const lineId = risk.cancelLabel === 'Go back' ? null : (risk.lines[0]?.lineId ?? null);
  return [
    { text: risk.cancelLabel, style: 'cancel', onPress: () => handlers.onFix(lineId) },
    { text: risk.confirmLabel, onPress: handlers.onProceed },
  ];
}
