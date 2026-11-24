import 'server-only';

import { cache } from 'react';

import { usableTimeZone } from '@stockpilot/core';

import { readSessionOrganization } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';

/**
 * THE ZONE THE PLATFORM ADMIN CHOSE, for the console's security pages (owner
 * request 2026-11-24). The app's one time-zone setting is per organization:
 * `organizations.timezone`, chosen under Settings, then Organization, then
 * Timezone. A person's own zone is the zone of the organization their
 * requests resolve to (requireOrgContext's rule: the profile's default
 * organization when it is an accepted membership, else the oldest), read
 * from the same request-cached load the gate already made, so no extra round
 * trip when get_request_context() answered.
 *
 * Null (no choice) when the account has no organization, the row cannot be
 * read, or the stored zone is one this runtime does not accept: the page then
 * prints UTC on the server, and the map's island the browser's zone. Never
 * the Pacific default resolveOrgTimezone() uses for a missing read: that
 * would claim a choice nobody made.
 *
 * Only after the gate: callers run requirePlatformAdmin() first.
 */
export const readPlatformViewerTimeZone = cache(async (): Promise<string | null> => {
  try {
    const read = await readSessionOrganization();
    if (!read.ok || read.organization === null) return null;
    const row = await getOrgRowForRequest(read.organization.organizationId);
    return usableTimeZone(row?.timezone);
  } catch {
    return null;
  }
});
