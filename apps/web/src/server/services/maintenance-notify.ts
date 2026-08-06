import 'server-only';

import {
  effectivePermissions,
  type Permission,
  type PermissionOverride,
  type Role,
} from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { type NotificationPrefKey } from '@/lib/notification-prefs';
import { createAdminClient } from '@/lib/supabase/admin';

import { createNotification } from './notifications';

/**
 * Master brief §26: "Authorized viewers" get new-request/urgent-request/
 * assigned pings; the requester gets their own draft-reminder/photo-rejected
 * pings. This module is the FIRST reader of Task 16's `notifyAudience` map
 * (apps/web/src/server/actions/maintenance-settings.ts) and the wiring point
 * for the 4 pref columns this task adds to notification-prefs.ts.
 *
 * BINDING CONSTRAINT: push delivery is the 0028 AFTER-INSERT trigger on
 * public.notifications — this module NEVER calls a push/expo API directly.
 * `createNotification` (./notifications) is the ONE insert path; every
 * recipient here goes through it, exactly once.
 */
export type MaintenanceNotifyEvent =
  | 'new_request'
  | 'urgent_request'
  | 'assigned'
  | 'draft_reminder'
  | 'photo_rejected'
  | 'resolved';

/** The narrowed 3-state set Task 16's settings action persists
 *  (organization_modules.settings.notifyAudience, keyed by userId). */
type MaintenanceNotifyMode = 'all' | 'urgent_only' | 'none';

/** Either permission makes a member an "authorized viewer" for the
 *  broadcast events (master brief §26) — union, not intersection. */
const AUDIENCE_PERMISSIONS: Permission[] = [
  'maintenance_requests:read_all',
  'maintenance_requests:manage',
];

/**
 * event -> the ONE notification_preferences column that gates it. Literal
 * strings (never re-derived) so a rename of the exported constant elsewhere
 * can't silently widen or narrow what this module reads.
 *
 * `photo_rejected` has NO entry on purpose: it tells the uploader their OWN
 * upload just failed — a requester-facing failure notice (brief §26's
 * "Requester: … photo upload failed"), not a broadcast an authorized viewer
 * can tune out. There is nothing to mute.
 */
const EVENT_PREF_KEY: Partial<Record<MaintenanceNotifyEvent, NotificationPrefKey>> = {
  new_request: 'push_maintenance_new_request',
  urgent_request: 'push_maintenance_urgent_request',
  assigned: 'push_maintenance_assigned',
  draft_reminder: 'push_maintenance_draft_reminder',
  resolved: 'push_maintenance_resolved',
};

function titleFor(event: MaintenanceNotifyEvent, requestHandle: string): string {
  switch (event) {
    case 'new_request':
      return `New maintenance request ${requestHandle}`;
    case 'urgent_request':
      return `Urgent maintenance request ${requestHandle}`;
    case 'assigned':
      return `Maintenance request ${requestHandle} assigned to you`;
    case 'draft_reminder':
      return `Reminder: finish your ${requestHandle} draft`;
    case 'photo_rejected':
      return `A photo on ${requestHandle} could not be saved`;
    case 'resolved':
      return `Maintenance request ${requestHandle} marked resolved`;
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled maintenance notify event: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Reads `notification_preferences.<key>` for a batch of users. Fail-OPEN
 * (the 0265 muteable-ping pattern): a missing row, or a read error, leaves
 * the user notified — only an explicit `false` on that exact column mutes.
 * Computed entirely in JS off the raw rows (this repo's supabase test mock
 * replays canned rows and does not simulate PostgREST filtering).
 */
async function loadPrefFlags(
  admin: ReturnType<typeof createAdminClient>,
  userIds: string[],
  key: NotificationPrefKey,
): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>(userIds.map((id) => [id, true]));
  if (userIds.length === 0) return flags;

  const { data, error } = await admin
    .from('notification_preferences')
    .select(`user_id, ${key}`)
    .in('user_id', userIds);
  if (error) {
    // A read failure is NOT evidence of a mute — fail open, same contract as
    // createNotification's own disabled_at check.
    void reportError(new Error(error.message), {
      tag: 'maintenance_notify.load_prefs',
      extra: { key },
    });
    return flags;
  }
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const userId = row.user_id as string;
    if (row[key] === false) flags.set(userId, false);
  }
  return flags;
}

/**
 * Resolves userIds holding `maintenance_requests:read_all` or `:manage`
 * EFFECTIVELY — static role defaults with org-level role overrides and
 * per-user overrides applied (packages/core's `effectivePermissions`,
 * exactly as `apps/web/src/lib/auth/effective-permissions.ts` computes it
 * for a single caller) — minus the actor, filtered by the org's
 * `notifyAudience` map (Task 16) and each recipient's own pref column.
 *
 * NEVER `_notify_recipients()` — that SQL helper is role-hardcoded and
 * shared across features; it cannot see a per-user grant like Andrew's
 * (a viewer granted `read_all` through `user_permission_overrides`), which
 * is exactly the case this function exists to get right.
 *
 * The override-loading query shape mirrors
 * `apps/web/src/server/actions/permissions.ts:189-258` — role overrides
 * scoped to `organization_id` (+ narrowed here to the two permissions that
 * matter), user overrides scoped to `organization_id`, both fed into
 * `effectivePermissions(role, roleOverrides, userOverrides)` per member —
 * just batched across every accepted member instead of one caller.
 *
 * `notifyAudience` absence = 'none': the settings panel
 * (maintenance-settings-panel.tsx) displays every unconfigured member's
 * selector as "None", and master brief §26 says the God Admin CHOOSES who
 * receives — being authorized to VIEW all requests is not, by itself,
 * an opt-in to being PINGED about every one.
 *
 * Never throws: a resolution failure is reported (never silently swallowed
 * into a false "zero recipients" success) and resolves to `[]` so the
 * caller's fire-and-forget emit never blocks or fails the parent write.
 */
export async function resolveMaintenanceAudience(args: {
  organizationId: string;
  event: 'new_request' | 'urgent_request';
  actorUserId: string;
}): Promise<string[]> {
  const { organizationId, event, actorUserId } = args;
  try {
    const admin = createAdminClient();

    const [membersRes, roleOverridesRes, userOverridesRes, moduleRes] = await Promise.all([
      admin
        .from('organization_members')
        .select('user_id, role')
        .eq('organization_id', organizationId)
        .not('accepted_at', 'is', null),
      admin
        .from('role_permission_overrides')
        .select('role, permission, granted')
        .eq('organization_id', organizationId)
        .in('permission', AUDIENCE_PERMISSIONS),
      admin
        .from('user_permission_overrides')
        .select('user_id, permission, granted')
        .eq('organization_id', organizationId)
        .in('permission', AUDIENCE_PERMISSIONS),
      admin
        .from('organization_modules')
        .select('settings')
        .eq('organization_id', organizationId)
        .eq('module_id', 'maintenance_requests')
        .maybeSingle(),
    ]);

    if (membersRes.error) throw new Error(membersRes.error.message);
    if (roleOverridesRes.error) throw new Error(roleOverridesRes.error.message);
    if (userOverridesRes.error) throw new Error(userOverridesRes.error.message);
    if (moduleRes.error) throw new Error(moduleRes.error.message);

    const members = (membersRes.data ?? []) as Array<{ user_id: string; role: Role }>;
    const roleOverrides = (roleOverridesRes.data ?? []) as Array<
      PermissionOverride & { role: Role }
    >;
    const userOverrides = (userOverridesRes.data ?? []) as Array<
      PermissionOverride & { user_id: string }
    >;
    const settings = (
      moduleRes.data as { settings?: { notifyAudience?: Record<string, MaintenanceNotifyMode> } } | null
    )?.settings;
    const notifyAudience = settings?.notifyAudience ?? {};

    // All computed in JS — the mock backing these tests replays canned
    // rows and does not simulate PostgREST filtering, so the actual
    // audience logic must live here, not in the query.
    const eligible: string[] = [];
    for (const member of members) {
      if (member.user_id === actorUserId) continue; // never notify the actor about their own action

      const roleOv = roleOverrides
        .filter((o) => o.role === member.role)
        .map(({ permission, granted }) => ({ permission, granted }));
      const userOv = userOverrides
        .filter((o) => o.user_id === member.user_id)
        .map(({ permission, granted }) => ({ permission, granted }));
      const effective = effectivePermissions(member.role, roleOv, userOv);
      const authorized =
        effective.has('maintenance_requests:read_all') || effective.has('maintenance_requests:manage');
      if (!authorized) continue;

      const mode: MaintenanceNotifyMode = notifyAudience[member.user_id] ?? 'none';
      if (mode === 'none') continue;
      if (mode === 'urgent_only' && event !== 'urgent_request') continue;
      eligible.push(member.user_id);
    }

    if (eligible.length === 0) return [];

    const prefKey = EVENT_PREF_KEY[event]!;
    const prefFlags = await loadPrefFlags(admin, eligible, prefKey);
    return eligible.filter((id) => prefFlags.get(id) !== false);
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'maintenance_notify.resolve_audience',
      extra: { organizationId, event },
    });
    return [];
  }
}

/**
 * Fans a maintenance event out to its recipients through `createNotification`
 * — never a direct push/expo call (push rides the 0028 AFTER-INSERT trigger
 * on every row that function inserts). Fire-and-forget by contract: never
 * throws, so a caller can `void notifyMaintenanceEvent(...).catch(...)`
 * immediately after its own audit write without delaying or failing it.
 *
 * `new_request`/`urgent_request` fan out to the permission-resolved audience
 * (`resolveMaintenanceAudience`, which already applies the pref gate).
 * `assigned`/`draft_reminder`/`photo_rejected`/`resolved` target a single
 * `targetUserId`, gated by that event's own pref column when one exists
 * (fail-open: missing row notifies, only an explicit `false` mutes).
 * `resolved` targets the REQUESTER only — the caller (resolve()) is
 * responsible for never passing a `targetUserId` equal to the resolver
 * (self-resolve suppression lives at the call site, not here).
 *
 * The link is always `/dashboard/maintenance/${requestId}` — this exact
 * shape is what Task 18's mobile web-path-rewrite rules translate into a
 * native deep link; changing it breaks that translation.
 */
export async function notifyMaintenanceEvent(args: {
  organizationId: string;
  event: MaintenanceNotifyEvent;
  requestId: string;
  requestHandle: string;
  subject: string;
  actorUserId: string;
  targetUserId?: string;
}): Promise<void> {
  const { organizationId, event, requestId, requestHandle, subject, targetUserId } = args;
  try {
    let recipients: string[];

    if (event === 'new_request' || event === 'urgent_request') {
      recipients = await resolveMaintenanceAudience({
        organizationId,
        event,
        actorUserId: args.actorUserId,
      });
    } else if (targetUserId) {
      const prefKey = EVENT_PREF_KEY[event];
      if (prefKey) {
        const admin = createAdminClient();
        const flags = await loadPrefFlags(admin, [targetUserId], prefKey);
        recipients = flags.get(targetUserId) === false ? [] : [targetUserId];
      } else {
        recipients = [targetUserId];
      }
    } else {
      recipients = [];
    }

    if (recipients.length === 0) return;

    const title = titleFor(event, requestHandle);
    await Promise.all(
      recipients.map((userId) =>
        createNotification({
          organizationId,
          userId,
          type: 'maintenance_request',
          title,
          body: subject,
          link: `/dashboard/maintenance/${requestId}`,
          metadata: { request_id: requestId, event },
        }),
      ),
    );
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'maintenance_notify.notify_event',
      extra: { organizationId, event, requestId },
    });
  }
}
