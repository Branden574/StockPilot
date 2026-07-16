'use server';

import { z } from 'zod';

import { ITEM_ACTIVITY_PAGE_SIZE } from '@/lib/activity-pagination';
import {
  ActivityService,
  UUID_RE,
  auditLimitFor,
  type ActivityCursor,
  type ActivityEvent,
} from '@/server/services/activity';
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

// Strict character whitelist (digits, `T`, `:`, `.`, `+`, `-`, `Z` only) —
// this string is interpolated directly into a raw PostgREST `.or()` filter
// string (ActivityService.forItem's composite keyset predicate), so beyond
// being date-shaped it must never contain `,` `(` `)` `'` or anything else
// that could break out of that filter's syntax. This is the injection
// defense; the `Date.parse` refinement below is the separate semantic
// (is-this-really-a-timestamp) check.
const ISO_TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+Z-]+$/;

const kindCursorSchema = z.object({
  createdAt: z
    .string()
    .regex(ISO_TIMESTAMP_RE, 'createdAt must be an ISO timestamp')
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: 'createdAt must be a valid ISO timestamp',
    }),
  // The RAW stock_movements.id / audit_logs.id (see ActivityKindCursor in
  // server/services/activity.ts) — both columns are `uuid primary key
  // default gen_random_uuid()`. A strict uuid shape both validates the
  // input and, like `createdAt` above, keeps this value safe to interpolate
  // into the raw `.or()` filter string `forItem` builds from it.
  id: z.string().regex(UUID_RE, 'id must be a uuid'),
});

const loadOlderSchema = z.object({
  itemId: z.string().uuid(),
  // Per-kind composite keyset cursor (Movement/Activity P4 review Blocker
  // 1 — see ActivityCursor). `nextActivityCursor` (lib/activity-pagination)
  // is the pure function both item-detail (initial page) and this action's
  // caller (the client wrapper, after each fetch) use to derive it. At
  // least one kind must be present — an empty `{}` means the caller
  // already knows there's nothing left to page through.
  before: z
    .object({
      movement: kindCursorSchema.optional(),
      audit: kindCursorSchema.optional(),
    })
    .refine((b) => b.movement !== undefined || b.audit !== undefined, {
      message: 'before must include at least one kind cursor',
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
  before: ActivityCursor;
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
