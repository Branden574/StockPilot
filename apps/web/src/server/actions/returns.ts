'use server';

import { revalidatePath } from 'next/cache';

import { revalidateInventoryListForCurrentOrg } from '@/server/loaders/inventory-list';
import { ServiceError } from '@/server/services/context';
import {
  RMAService,
  type ReturnPlanAnswer,
  type ReturnStepResult,
  type ReturnTransitionAnswer,
} from '@/server/services/returns';
import type { ReturnWorkbench } from '@/server/services/returns-workbench';
import { ShippingService, type CarrierShipmentRow } from '@/server/services/shipping';

import { err, ok, parseReturnBody, type ActionResult } from '@stockpilot/core';

/**
 * Server actions over RMAService (returns RX-1). Approve, receive and
 * process run through runReturnStepsAction (the twin of the steps endpoint,
 * plan 3.3.8), each step one database function; deny, cancel and the
 * destination planner have their own. Each one parses the body
 * with core's shared schema, calls ONE service method (which calls one
 * database function), revalidates, and maps a refusal to an ActionResult
 * that keeps the database hint in `details.reason`, so the screen picks its
 * words by reason (pattern 28), never by message text.
 *
 * No `export type` re-exports from this file (pattern 25): a 'use server'
 * module may only export async functions. The result types live in the
 * service and in core.
 */

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    const details = error.code !== 'internal_error' ? error.details : { reason: 'failed' };
    return err(error.code, error.message, details);
  }
  return err('internal_error', 'Something went wrong. Try again.', { reason: 'failed' });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badId(): ActionResult<never> {
  return err('validation_error', 'That return id is not valid.', { reason: 'return_invalid' });
}

function revalidateReturn(id: string, orderId?: string) {
  revalidatePath('/dashboard/returns');
  revalidatePath(`/dashboard/returns/${id}`);
  if (orderId) revalidatePath(`/dashboard/orders/${orderId}`);
}

/**
 * Staff create from an order. `idempotencyKey` is minted when the dialog
 * opens (the same key on a resend replays the same RMA).
 */
export async function createReturnFromOrderAction(input: {
  orderRequestId: string;
  reasonCode?: 'damaged' | 'wrong_item' | 'end_of_year' | 'overage' | 'other';
  notes?: string;
  lines: Array<{ orderRequestLineId: string; quantity: number; disposition: 'restock' | 'scrap' }>;
  itemIsHere?: boolean;
  idempotencyKey?: string;
}): Promise<ActionResult<{ id: string; returnNumber: string | null; replay: boolean; channel: 'staff' | 'counter' }>> {
  if (!UUID_RE.test(input?.orderRequestId ?? '')) {
    return err('validation_error', 'That order id is not valid.', { reason: 'return_invalid' });
  }
  const parsed = parseReturnBody('create', {
    reasonCode: input.reasonCode,
    notes: input.notes,
    lines: input.lines,
    itemIsHere: input.itemIsHere,
    idempotencyKey: input.idempotencyKey,
  });
  if (!parsed.ok) return err('validation_error', parsed.message, { reason: 'return_invalid' });
  try {
    const svc = await RMAService.forCurrentUser();
    const created = await svc.createFromOrder(input.orderRequestId, parsed.value, {
      idempotencyKey: parsed.value.idempotencyKey ?? null,
    });
    revalidateReturn(created.id, input.orderRequestId);
    return ok({ id: created.id, returnNumber: created.return_number, replay: created.replay, channel: created.channel });
  } catch (e) {
    return toResult(e);
  }
}

export async function denyReturnAction(input: { id: string; reason: string }): Promise<ActionResult<ReturnTransitionAnswer>> {
  if (!UUID_RE.test(input?.id ?? '')) return badId();
  const parsed = parseReturnBody('deny', { reason: input.reason ?? '' });
  if (!parsed.ok) return err('validation_error', parsed.message, { reason: 'reason_required' });
  try {
    const svc = await RMAService.forCurrentUser();
    const answer = await svc.deny(input.id, parsed.value.reason);
    revalidateReturn(input.id);
    return ok(answer);
  } catch (e) {
    return toResult(e);
  }
}

export async function cancelReturnAction(input: {
  id: string;
  expectedRevision?: number | null;
  reason?: string | null;
}): Promise<ActionResult<ReturnTransitionAnswer>> {
  if (!UUID_RE.test(input?.id ?? '')) return badId();
  const parsed = parseReturnBody('cancel', { expectedRevision: input.expectedRevision ?? null, reason: input.reason ?? null });
  if (!parsed.ok) return err('validation_error', parsed.message, { reason: 'return_invalid' });
  try {
    const svc = await RMAService.forCurrentUser();
    const answer = await svc.cancel(input.id, parsed.value);
    revalidateReturn(input.id);
    return ok(answer);
  } catch (e) {
    return toResult(e);
  }
}

/** Change where unapplied lines go (approved or received). */
export async function planReturnDispositionsAction(input: { id: string; lines: unknown }): Promise<ActionResult<ReturnPlanAnswer>> {
  if (!UUID_RE.test(input?.id ?? '')) return badId();
  const parsed = parseReturnBody('dispositions', { lines: input.lines });
  if (!parsed.ok) return err('validation_error', parsed.message, { reason: 'return_invalid' });
  try {
    const svc = await RMAService.forCurrentUser();
    const answer = await svc.planDispositions(input.id, parsed.value.lines);
    revalidateReturn(input.id);
    return ok(answer);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * The steps twin of POST /api/v1/returns/[id]/steps (plan 3.3.8): approve,
 * receive, process in order, each its own transaction; the answer carries
 * the whole workbench.
 */
export async function runReturnStepsAction(input: {
  id: string;
  body: unknown;
}): Promise<ActionResult<{ ran: ReturnStepResult[]; workbench: ReturnWorkbench }>> {
  if (!UUID_RE.test(input?.id ?? '')) return badId();
  const parsed = parseReturnBody('steps', input.body);
  if (!parsed.ok) return err('validation_error', parsed.message, { reason: 'return_invalid' });
  try {
    const svc = await RMAService.forCurrentUser();
    const result = await svc.runSteps(input.id, parsed.value);
    revalidateReturn(input.id);
    if (result.ran.some((r) => r.step === 'process' && r.outcome === 'done')) {
      revalidatePath('/dashboard/inventory');
      revalidatePath('/dashboard/staging');
      await revalidateInventoryListForCurrentOrg();
      revalidatePath('/dashboard');
    }
    return ok(result);
  } catch (e) {
    return toResult(e);
  }
}

/**
 * Buy a reverse (RMA) EasyPost label for an approved or received return.
 * ShippingService gates on the shipping module and shipping:manage, and is
 * idempotent (an existing purchased label short-circuits).
 */
export async function buyReturnLabelAction(id: string): Promise<ActionResult<CarrierShipmentRow>> {
  if (!UUID_RE.test(id ?? '')) return badId();
  try {
    const svc = await ShippingService.forCurrentUser();
    const shipment = await svc.buyReturnLabel(id);
    revalidateReturn(id);
    return ok(shipment);
  } catch (e) {
    return toResult(e);
  }
}
