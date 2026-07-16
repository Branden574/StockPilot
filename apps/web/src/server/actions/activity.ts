'use server';

import { z } from 'zod';

import { ITEM_ACTIVITY_PAGE_SIZE } from '@/lib/activity-pagination';
import { ActivityService, auditLimitFor, type ActivityEvent } from '@/server/services/activity';
import { ServiceError } from '@/server/services/context';
import { LocationsService } from '@/server/services/locations';

import { err, ok, type ActionResult } from '@stockpilot/core';

function toResult<T>(error: unknown): ActionResult<T> {
  if (error instanceof ServiceError) {
    return err(error.code, error.message);
  }
  // Never surface a raw exception message (DB / network internals) to the
  // client — log server-side, return a generic string (S13 boundary).
  console.error(error);
  return err('internal_error', 'Something went wrong. Please try again.');
}

const loadOlderSchema = z.object({
  itemId: z.string().uuid(),
  // ISO timestamp cursor — the createdAt of the oldest event the caller
  // already has. `nextActivityCursor` (lib/activity-pagination) is the
  // pure function both item-detail (initial page) and this action's
  // caller (client wrapper, after each fetch) use to derive it.
  before: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'before must be a valid ISO timestamp',
  }),
});

export interface LoadOlderItemActivityData {
  events: ActivityEvent[];
  /**
   * Location id → name, scoped to ONLY the ids referenced by `events`
   * (transfers' from/to, receives' to, removals' from) — mirrors how
   * item-detail resolves the map for the first, server-rendered page
   * (LocationsService.list(), active locations only), just narrowed to
   * this page's rows instead of the whole org. The client wrapper merges
   * this into its running map; already-known ids overlap harmlessly.
   */
  locationNames: Record<string, string>;
  /**
   * True when this fetch returned FEWER than the full per-kind cap for
   * BOTH movements and audits — i.e. neither kind has any more rows to
   * page through, so the "Load older" button should hide. A kind that DID
   * hit its cap might still have more rows even if the other kind is
   * exhausted, so this is an AND, never an OR, across kinds.
   */
  exhausted: boolean;
}

export async function loadOlderItemActivityAction(input: {
  itemId: string;
  before: string;
}): Promise<ActionResult<LoadOlderItemActivityData>> {
  const parsed = loadOlderSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  try {
    // ActivityService.forCurrentUser() / LocationsService.forCurrentUser()
    // both resolve via withContext() — the SAME org/permission-scoped,
    // user-authed context the item-detail page itself renders under.
    // Never a raw admin client: every underlying query stays org-scoped
    // (`.eq('organization_id', ctx.organizationId)`) and RLS-enforced
    // (audit_logs' manager+ SELECT policy applies exactly as it does on
    // first render), so an itemId from another org simply yields empty
    // results rather than leaking rows.
    const activitySvc = await ActivityService.forCurrentUser();
    const events = await activitySvc.forItem(parsed.data.itemId, ITEM_ACTIVITY_PAGE_SIZE, {
      before: parsed.data.before,
    });

    const movementCount = events.filter((e) => e.kind === 'movement').length;
    const auditCount = events.filter((e) => e.kind === 'audit').length;
    const exhausted =
      movementCount < ITEM_ACTIVITY_PAGE_SIZE && auditCount < auditLimitFor(ITEM_ACTIVITY_PAGE_SIZE);

    const referencedLocationIds = new Set<string>();
    for (const e of events) {
      if (e.fromLocationId) referencedLocationIds.add(e.fromLocationId);
      if (e.toLocationId) referencedLocationIds.add(e.toLocationId);
    }
    let locationNames: Record<string, string> = {};
    if (referencedLocationIds.size > 0) {
      const locationsSvc = await LocationsService.forCurrentUser();
      const locations = await locationsSvc.list();
      locationNames = Object.fromEntries(
        locations
          .filter((l) => referencedLocationIds.has(l.id as string))
          .map((l) => [l.id as string, l.name as string]),
      );
    }

    return ok({ events, locationNames, exhausted });
  } catch (e) {
    return toResult(e);
  }
}
