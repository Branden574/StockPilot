import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertModuleEnabled, ServiceError, withContext, type ServiceContext } from './context';
import { addressToLine, geocodeAddress } from './geocode';
import { haversineMiles, isStale } from '@stockpilot/core';

export interface DriverPoint { lat: number; lng: number; heading?: number; accuracy?: number; }

export interface PublicLocationResult {
  available: boolean;
  driver?: { lat: number; lng: number; heading: number | null; recordedAt: string };
  destination?: { lat: number; lng: number } | null;
  distanceMiles?: number | null;
}

const STALE_SEC = 5 * 60;

export class DeliveryTrackingService {
  constructor(private readonly ctx: ServiceContext) {}
  static async forCurrentUser() { return new DeliveryTrackingService(await withContext()); }

  /** DRIVER: record the assigned driver's latest point for an in-transit delivery. */
  async shareLocation(orderId: string, p: DriverPoint): Promise<void> {
    assertModuleEnabled(this.ctx, 'live_tracking');
    const { data: order, error } = await this.ctx.supabase
      .from('order_requests')
      .select('id, organization_id, fulfillment_type, status, assigned_delivery_user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', orderId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!order) throw new ServiceError('not_found', 'Order not found.');
    const o = order as { fulfillment_type: string; status: string; assigned_delivery_user_id: string | null };
    if (o.assigned_delivery_user_id !== this.ctx.userId) {
      throw new ServiceError('forbidden', 'Only the assigned driver can share location for this order.');
    }
    if (o.fulfillment_type !== 'delivery' || o.status !== 'in_transit') {
      throw new ServiceError('validation_error', 'Location sharing is only active for an in-transit delivery.');
    }
    const { error: upErr } = await this.ctx.supabase
      .from('delivery_locations')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          order_request_id: orderId,
          driver_user_id: this.ctx.userId,
          lat: p.lat,
          lng: p.lng,
          heading: p.heading ?? null,
          accuracy: p.accuracy ?? null,
          recorded_at: new Date().toISOString(),
        },
        { onConflict: 'order_request_id' },
      );
    if (upErr) throw new ServiceError('internal_error', upErr.message);
  }

  /** Delete the live point when an order leaves in_transit (completed/cancelled). */
  async purgeForOrder(orderId: string): Promise<void> {
    await this.ctx.supabase.from('delivery_locations').delete().eq('order_request_id', orderId);
  }
}

/**
 * CUSTOMER (unauthenticated) path — verified by token+id+email upstream in the
 * route. Uses the service-role admin client; returns {available:false} for any
 * gate miss (module off, not delivery, not in_transit, stale, no point).
 */
export async function getPublicDriverLocation(args: {
  orgId: string;
  orderId: string;
}): Promise<PublicLocationResult> {
  const admin = createAdminClient();

  // Module gate (service-role, by org).
  const { data: mod } = await admin
    .from('organization_modules')
    .select('enabled')
    .eq('organization_id', args.orgId)
    .eq('module_id', 'live_tracking')
    .maybeSingle();
  if (!(mod as { enabled?: boolean } | null)?.enabled) return { available: false };

  const { data: order } = await admin
    .from('order_requests')
    .select('id, fulfillment_type, status, delivery_charter_id')
    .eq('id', args.orderId)
    .eq('organization_id', args.orgId)
    .maybeSingle();
  const o = order as { fulfillment_type?: string; status?: string; delivery_charter_id?: string | null } | null;
  if (!o || o.fulfillment_type !== 'delivery' || o.status !== 'in_transit') return { available: false };

  const { data: loc } = await admin
    .from('delivery_locations')
    .select('lat, lng, heading, recorded_at')
    .eq('order_request_id', args.orderId)
    .maybeSingle();
  const l = loc as { lat: number; lng: number; heading: number | null; recorded_at: string } | null;
  if (!l || isStale(l.recorded_at, new Date(), STALE_SEC)) return { available: false };

  // Destination: the delivery charter's address (geocode once, cache on charters).
  let destination: { lat: number; lng: number } | null = null;
  if (o.delivery_charter_id) {
    const { data: ch } = await admin
      .from('charters')
      .select('address, geocoded_lat, geocoded_lng')
      .eq('id', o.delivery_charter_id)
      .maybeSingle();
    const c = ch as { address: unknown; geocoded_lat: number | null; geocoded_lng: number | null } | null;
    if (c?.geocoded_lat != null && c?.geocoded_lng != null) {
      destination = { lat: c.geocoded_lat, lng: c.geocoded_lng };
    } else if (c?.address) {
      const geo = await geocodeAddress(addressToLine(c.address));
      if (geo) {
        destination = geo;
        await admin.from('charters')
          .update({ geocoded_lat: geo.lat, geocoded_lng: geo.lng, geocoded_at: new Date().toISOString() })
          .eq('id', o.delivery_charter_id);
      }
    }
  }

  return {
    available: true,
    driver: { lat: l.lat, lng: l.lng, heading: l.heading, recordedAt: l.recorded_at },
    destination,
    distanceMiles: destination ? haversineMiles({ lat: l.lat, lng: l.lng }, destination) : null,
  };
}
