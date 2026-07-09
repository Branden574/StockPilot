import 'server-only';

import { z } from 'zod';

import { planAllowsB2bPortal, type OrgBillingState } from '@stockpilot/core';

import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/resend';
import { createAdminClient } from '@/lib/supabase/admin';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { audit } from './audit';

// ── Schemas ─────────────────────────────────────────────────────────────────

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).nullable().optional(),
  priceListId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export interface CustomerRow {
  id: string;
  name: string;
  status: 'active' | 'archived';
  notes: string | null;
  price_list_id: string | null;
  price_list_name: string | null;
  user_count: number;
  catalog_count: number;
  created_at: string;
}

/**
 * B2B customers — Phase 1 org-side management (spec:
 * docs/superpowers/specs/2026-07-09-b2b-portal-design.md).
 *
 * Every method gates on the b2b_portal module + customers:manage; mutations
 * that GROW the portal surface (create customer, invite user) additionally
 * require a Business+ effective plan. RLS (0250) re-enforces org scope and the
 * manager/permission floor on the user-authed client.
 */
export class CustomersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser(): Promise<CustomersService> {
    return new CustomersService(await withContext());
  }

  private gate(): void {
    assertModuleEnabled(this.ctx, 'b2b_portal');
    assertPermission(this.ctx, 'customers:manage');
  }

  /** Business+ effective-plan check for surface-growing mutations. */
  private async assertPlanAllows(): Promise<void> {
    const { data } = await this.ctx.supabase
      .from('organizations')
      .select(
        'plan, access_tier, billing_arrangement, stripe_subscription_id, trial_ends_at, trial_tier',
      )
      .eq('id', this.ctx.organizationId)
      .maybeSingle();
    const billing = ((data as OrgBillingState | null) ?? { plan: null }) as OrgBillingState;
    if (!planAllowsB2bPortal(billing)) {
      throw new ServiceError(
        'plan_limit_exceeded',
        'The B2B customer portal needs the Business plan or above.',
      );
    }
  }

  // ── Customers ─────────────────────────────────────────────────────────────

  async list(): Promise<CustomerRow[]> {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('customers')
      .select(
        `id, name, status, notes, price_list_id, created_at,
         price_list:price_lists(name),
         customer_users(count),
         customer_catalog(count)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const pl = r.price_list as { name: string | null } | { name: string | null }[] | null;
      const plObj = Array.isArray(pl) ? pl[0] : pl;
      const users = r.customer_users as Array<{ count: number }> | null;
      const catalog = r.customer_catalog as Array<{ count: number }> | null;
      return {
        id: r.id as string,
        name: r.name as string,
        status: r.status as 'active' | 'archived',
        notes: (r.notes as string | null) ?? null,
        price_list_id: (r.price_list_id as string | null) ?? null,
        price_list_name: plObj?.name ?? null,
        user_count: users?.[0]?.count ?? 0,
        catalog_count: catalog?.[0]?.count ?? 0,
        created_at: r.created_at as string,
      };
    });
  }

  async create(input: CustomerInput): Promise<{ id: string }> {
    this.gate();
    await this.assertPlanAllows();
    const parsed = customerSchema.parse(input);
    const { data, error } = await this.ctx.supabase
      .from('customers')
      .insert({
        organization_id: this.ctx.organizationId,
        name: parsed.name,
        notes: parsed.notes ?? null,
        price_list_id: parsed.priceListId ?? null,
        created_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      { event: 'organization.updated', entityType: 'customer', entityId: data.id as string, extra: { action: 'customer_created', name: parsed.name } },
      this.ctx,
    );
    return { id: data.id as string };
  }

  async update(id: string, input: CustomerInput): Promise<void> {
    this.gate();
    const parsed = customerSchema.parse(input);
    const { data, error } = await this.ctx.supabase
      .from('customers')
      .update({
        name: parsed.name,
        notes: parsed.notes ?? null,
        price_list_id: parsed.priceListId ?? null,
        ...(parsed.status ? { status: parsed.status } : {}),
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Customer not found');
  }

  // ── Price lists ───────────────────────────────────────────────────────────

  async listPriceLists(): Promise<Array<{ id: string; name: string; item_count: number }>> {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('price_lists')
      .select('id, name, price_list_items(count)')
      .eq('organization_id', this.ctx.organizationId)
      .order('name')
      .limit(200);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      item_count: (r.price_list_items as Array<{ count: number }> | null)?.[0]?.count ?? 0,
    }));
  }

  async createPriceList(name: string): Promise<{ id: string }> {
    this.gate();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) {
      throw new ServiceError('validation_error', 'Price list name is required (max 200 chars).');
    }
    const { data, error } = await this.ctx.supabase
      .from('price_lists')
      .insert({ organization_id: this.ctx.organizationId, name: trimmed })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return { id: data.id as string };
  }

  async listPrices(priceListId: string): Promise<
    Array<{ item_id: string; unit_price: number; name: string | null; sku: string | null }>
  > {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('price_list_items')
      .select('item_id, unit_price, item:inventory_items(name, sku)')
      .eq('price_list_id', priceListId)
      .limit(1000);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const item = r.item as { name: string | null; sku: string | null } | { name: string | null; sku: string | null }[] | null;
      const itemObj = Array.isArray(item) ? item[0] : item;
      return {
        item_id: r.item_id as string,
        unit_price: Number(r.unit_price) || 0,
        name: itemObj?.name ?? null,
        sku: itemObj?.sku ?? null,
      };
    });
  }

  async setPrice(priceListId: string, itemId: string, unitPrice: number): Promise<void> {
    this.gate();
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new ServiceError('validation_error', 'Price must be ≥ 0.');
    }
    // Verify BOTH parents belong to this org before writing the join row —
    // RLS re-checks the price list, and the item check stops cross-org ids.
    const [{ data: pl }, { data: item }] = await Promise.all([
      this.ctx.supabase
        .from('price_lists')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', priceListId)
        .maybeSingle(),
      this.ctx.supabase
        .from('inventory_items')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', itemId)
        .is('deleted_at', null)
        .maybeSingle(),
    ]);
    if (!pl) throw new ServiceError('not_found', 'Price list not found');
    if (!item) throw new ServiceError('not_found', 'Item not found');
    const { error } = await this.ctx.supabase
      .from('price_list_items')
      .upsert(
        { price_list_id: priceListId, item_id: itemId, unit_price: unitPrice },
        { onConflict: 'price_list_id,item_id' },
      );
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async removePrice(priceListId: string, itemId: string): Promise<void> {
    this.gate();
    const { error } = await this.ctx.supabase
      .from('price_list_items')
      .delete()
      .eq('price_list_id', priceListId)
      .eq('item_id', itemId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  // ── Catalog allowlist ─────────────────────────────────────────────────────

  async listCatalog(customerId: string): Promise<
    Array<{ item_id: string; name: string | null; sku: string | null }>
  > {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('customer_catalog')
      .select('item_id, item:inventory_items(name, sku)')
      .eq('customer_id', customerId)
      .limit(1000);
    if (error) throw new ServiceError('internal_error', error.message);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const item = r.item as { name: string | null; sku: string | null } | { name: string | null; sku: string | null }[] | null;
      const itemObj = Array.isArray(item) ? item[0] : item;
      return { item_id: r.item_id as string, name: itemObj?.name ?? null, sku: itemObj?.sku ?? null };
    });
  }

  async addCatalogItem(customerId: string, itemId: string): Promise<void> {
    this.gate();
    const [{ data: cust }, { data: item }] = await Promise.all([
      this.ctx.supabase
        .from('customers')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', customerId)
        .maybeSingle(),
      this.ctx.supabase
        .from('inventory_items')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', itemId)
        .is('deleted_at', null)
        .maybeSingle(),
    ]);
    if (!cust) throw new ServiceError('not_found', 'Customer not found');
    if (!item) throw new ServiceError('not_found', 'Item not found');
    const { error } = await this.ctx.supabase
      .from('customer_catalog')
      .upsert({ customer_id: customerId, item_id: itemId }, { onConflict: 'customer_id,item_id' });
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async removeCatalogItem(customerId: string, itemId: string): Promise<void> {
    this.gate();
    const { error } = await this.ctx.supabase
      .from('customer_catalog')
      .delete()
      .eq('customer_id', customerId)
      .eq('item_id', itemId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  // ── Portal users ──────────────────────────────────────────────────────────

  async listUsers(customerId: string): Promise<
    Array<{ user_id: string; email: string; invited_at: string; accepted_at: string | null }>
  > {
    this.gate();
    const { data, error } = await this.ctx.supabase
      .from('customer_users')
      .select('user_id, email, invited_at, accepted_at')
      .eq('customer_id', customerId)
      .order('invited_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as Array<{
      user_id: string;
      email: string;
      invited_at: string;
      accepted_at: string | null;
    }>;
  }

  /**
   * Invite a portal user by email: mints a magic link via admin.generateLink
   * (NEVER inviteUserByEmail — Supabase's built-in mailer is rate-capped, see
   * the auth-emails memory/f812bb4a) and sends it via Resend. Creates the auth
   * user when new; safe to re-run for an existing portal user (re-sends).
   */
  async inviteUser(customerId: string, email: string): Promise<void> {
    this.gate();
    await this.assertPlanAllows();
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new ServiceError('validation_error', 'Enter a valid email address.');
    }
    // Never a dashboard member of THIS org — the two principals must not mix.
    const { data: customer } = await this.ctx.supabase
      .from('customers')
      .select('id, name')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', customerId)
      .maybeSingle();
    if (!customer) throw new ServiceError('not_found', 'Customer not found');

    const admin = createAdminClient();
    const { data: memberHit } = await admin
      .from('organization_members')
      .select('user_id, user:user_profiles!user_id(email)')
      .eq('organization_id', this.ctx.organizationId);
    const memberEmails = new Set(
      ((memberHit ?? []) as Array<{ user: { email: string | null } | { email: string | null }[] | null }>)
        .map((m) => (Array.isArray(m.user) ? m.user[0] : m.user))
        .map((u) => (u?.email ?? '').toLowerCase())
        .filter(Boolean),
    );
    if (memberEmails.has(normalized)) {
      throw new ServiceError(
        'validation_error',
        'That email belongs to a team member of this workspace — portal customers must use a separate account.',
      );
    }

    // Mint the link: 'invite' creates a brand-new auth user; for an existing
    // user it fails, so fall back to 'magiclink'. generateLink's response
    // carries the (possibly just-created) auth user — no directory scan needed.
    let linkType: 'invite' | 'magiclink' = 'invite';
    let linkRes = await admin.auth.admin.generateLink({ type: 'invite', email: normalized });
    if (linkRes.error) {
      linkType = 'magiclink';
      linkRes = await admin.auth.admin.generateLink({ type: 'magiclink', email: normalized });
      if (linkRes.error) {
        throw new ServiceError('internal_error', `Could not create the invite link: ${linkRes.error.message}`);
      }
    }
    const hashedToken = linkRes.data?.properties?.hashed_token;
    const authUserId = linkRes.data?.user?.id;
    if (!hashedToken || !authUserId) {
      throw new ServiceError('internal_error', 'Invite link was empty.');
    }

    const { error: mapErr } = await this.ctx.supabase
      .from('customer_users')
      .upsert(
        {
          customer_id: customerId,
          user_id: authUserId,
          email: normalized,
          invited_by: this.ctx.userId,
        },
        { onConflict: 'customer_id,user_id' },
      );
    if (mapErr) throw new ServiceError('internal_error', mapErr.message);

    const confirmUrl =
      `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?token_hash=${encodeURIComponent(hashedToken)}` +
      `&type=${linkType}&next=${encodeURIComponent('/portal')}`;
    const sent = await sendEmail({
      to: normalized,
      subject: `You're invited to order from ${(customer as { name: string }).name}'s supplier portal`,
      html:
        `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#111">` +
        `<p>Hi,</p>` +
        `<p>You've been invited to the ordering portal for <strong>${escapeHtml((customer as { name: string }).name)}</strong>. ` +
        `Use the button below to sign in — no password needed.</p>` +
        `<p><a href="${confirmUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open the portal</a></p>` +
        `<p style="color:#666;font-size:12px">Or paste this link into your browser:<br>${confirmUrl}</p>` +
        `</div>`,
      text: `You've been invited to the ordering portal. Sign in here (no password needed):\n${confirmUrl}`,
    });
    if (!sent) throw new ServiceError('internal_error', 'The invite email could not be sent.');

    await audit(
      {
        event: 'organization.updated',
        entityType: 'customer',
        entityId: customerId,
        extra: { action: 'portal_user_invited', email: normalized },
      },
      this.ctx,
    );
  }

  async removeUser(customerId: string, userId: string): Promise<void> {
    this.gate();
    const { error } = await this.ctx.supabase
      .from('customer_users')
      .delete()
      .eq('customer_id', customerId)
      .eq('user_id', userId);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
