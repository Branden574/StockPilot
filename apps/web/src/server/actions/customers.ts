'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { ServiceError, withContext } from '@/server/services/context';
import { CustomersService, customerSchema, type CustomerInput } from '@/server/services/customers';

import { err, ok, type ActionResult, type PortalPricingMode } from '@stockpilot/core';

// ---------------------------------------------------------------------------
// B2B customers (Phase 1) actions. The service gates module + customers:manage
// + Business-plan (on surface-growing mutations) internally; actions add the
// MFA fail-closed check (mirrors recurring-pos.ts) and cache revalidation.
// ---------------------------------------------------------------------------

const REVALIDATE_PATH = '/dashboard/customers';

async function gated(): Promise<{ svc: CustomersService | null; error: ReturnType<typeof err> | null }> {
  const ctx = await withContext();
  if (ctx.mfaRequired && !ctx.mfaSatisfied) {
    return {
      svc: null,
      error: err(
        'forbidden',
        'Multi-factor authentication required. Enroll in MFA before performing this action.',
      ),
    };
  }
  return { svc: new CustomersService(ctx), error: null };
}

function toResult(e: unknown): ActionResult<never> {
  if (e instanceof ServiceError) return err(e.code, e.message);
  return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
}

export async function createCustomerAction(
  input: CustomerInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = customerSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    const created = await svc.create(parsed.data);
    revalidatePath(REVALIDATE_PATH);
    return ok(created);
  } catch (e) {
    return toResult(e);
  }
}

export async function updateCustomerAction(
  input: { id: string } & CustomerInput,
): Promise<ActionResult<void>> {
  const idParse = z.string().uuid().safeParse(input.id);
  const parsed = customerSchema.safeParse(input);
  if (!idParse.success || !parsed.success) return err('validation_error', 'Invalid input');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.update(idParse.data, parsed.data);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const inviteSchema = z.object({ customerId: z.string().uuid(), email: z.string().email() });
export async function inviteCustomerUserAction(
  input: z.input<typeof inviteSchema>,
): Promise<ActionResult<void>> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Enter a valid email address.');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.inviteUser(parsed.data.customerId, parsed.data.email);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const removeUserSchema = z.object({ customerId: z.string().uuid(), userId: z.string().uuid() });
export async function removeCustomerUserAction(
  input: z.input<typeof removeUserSchema>,
): Promise<ActionResult<void>> {
  const parsed = removeUserSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.removeUser(parsed.data.customerId, parsed.data.userId);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const priceListSchema = z.object({ name: z.string().trim().min(1).max(200) });
export async function createPriceListAction(
  input: z.input<typeof priceListSchema>,
): Promise<ActionResult<{ id: string }>> {
  const parsed = priceListSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Price list name is required.');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    const created = await svc.createPriceList(parsed.data.name);
    revalidatePath(REVALIDATE_PATH);
    return ok(created);
  } catch (e) {
    return toResult(e);
  }
}

const setPriceSchema = z.object({
  priceListId: z.string().uuid(),
  itemId: z.string().uuid(),
  unitPrice: z.coerce.number().min(0),
});
export async function setPriceAction(
  input: z.input<typeof setPriceSchema>,
): Promise<ActionResult<void>> {
  const parsed = setPriceSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Price must be a number ≥ 0.');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.setPrice(parsed.data.priceListId, parsed.data.itemId, parsed.data.unitPrice);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const removePriceSchema = z.object({ priceListId: z.string().uuid(), itemId: z.string().uuid() });
export async function removePriceAction(
  input: z.input<typeof removePriceSchema>,
): Promise<ActionResult<void>> {
  const parsed = removePriceSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.removePrice(parsed.data.priceListId, parsed.data.itemId);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const catalogSchema = z.object({ customerId: z.string().uuid(), itemId: z.string().uuid() });
export async function addCatalogItemAction(
  input: z.input<typeof catalogSchema>,
): Promise<ActionResult<void>> {
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.addCatalogItem(parsed.data.customerId, parsed.data.itemId);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

const pricingModeSchema = z.enum(['no_charge', 'priced']);

/**
 * Set how this org's portal treats money. Merges into the b2b_portal
 * module's settings jsonb — a wholesale replace would wipe any other
 * setting stored there.
 */
export async function setPortalPricingModeAction(
  mode: PortalPricingMode,
): Promise<ActionResult<void>> {
  const parsed = pricingModeSchema.safeParse(mode);
  if (!parsed.success) return err('validation_error', 'Invalid pricing mode');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.setPricingMode(parsed.data);
    revalidatePath(REVALIDATE_PATH);
    revalidatePath('/portal');
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}

export async function removeCatalogItemAction(
  input: z.input<typeof catalogSchema>,
): Promise<ActionResult<void>> {
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid input');
  const { svc, error } = await gated();
  if (error || !svc) return error as ActionResult<never>;
  try {
    await svc.removeCatalogItem(parsed.data.customerId, parsed.data.itemId);
    revalidatePath(REVALIDATE_PATH);
    return ok(undefined);
  } catch (e) {
    return toResult(e);
  }
}
