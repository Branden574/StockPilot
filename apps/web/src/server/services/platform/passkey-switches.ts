import 'server-only';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRowsByIds } from '@/server/services/lib/fetch-by-ids';
import { fetchAllRows } from '@/server/services/lib/paginate';

/**
 * The passkey switches as the platform console reads them (part 2, plan 2.6
 * H and section 4). Service-role reads: the caller has already passed the
 * platform-admin gate. The writes are the console's actions
 * (server/actions/platform/passkeys.ts).
 *
 * The switches (migration 0475): platform_settings.passkeys_on (the kill
 * switch) and platform_settings.passkey_adds_on ("new passkeys"), both off
 * when the one settings row does not exist; and a row in
 * organization_passkey_switches per organization that has passkeys on.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * For each organization named: how many of its members hold at least one
 * active passkey (not removed). A member is an accepted membership that is not
 * an act-as seat (0475's passkey_add_allowed rule, 0413's and 0473's). Two
 * reads, both paged and batched: the memberships of these organizations, then
 * the active passkeys of those accounts. Throws when either read fails; the
 * caller decides what an unknown count means.
 */
export async function countPasskeyHolders(
  admin: AdminClient,
  organizationIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(organizationIds.map((id) => [id, 0]));
  if (organizationIds.length === 0) return counts;

  const memberships = await fetchAllRowsByIds<{ user_id: string | null; organization_id: string }>(
    organizationIds,
    (batch) => (from, to) =>
      admin
        .from('organization_members')
        .select('id, user_id, organization_id')
        .in('organization_id', batch)
        .not('accepted_at', 'is', null)
        .is('impersonation_expires_at', null)
        .order('id')
        .range(from, to),
    { requireList: 'organization_members' },
  );
  const userIds = [...new Set(memberships.map((m) => m.user_id).filter((u): u is string => !!u))];
  if (userIds.length === 0) return counts;

  const active = await fetchAllRowsByIds<{ user_id: string }>(
    userIds,
    (batch) => (from, to) =>
      admin
        .from('member_passkeys')
        .select('id, user_id')
        .in('user_id', batch)
        .is('removed_at', null)
        .order('id')
        .range(from, to),
    { requireList: 'member_passkeys' },
  );
  const holders = new Set(active.map((p) => p.user_id));

  const seen = new Map<string, Set<string>>();
  for (const m of memberships) {
    if (!m.user_id || !holders.has(m.user_id)) continue;
    const set = seen.get(m.organization_id) ?? new Set<string>();
    set.add(m.user_id);
    seen.set(m.organization_id, set);
  }
  for (const [orgId, set] of seen) counts.set(orgId, set.size);
  return counts;
}

/**
 * How many members of one organization still hold an active passkey (the
 * console's answer for an organization turned off), or null when that could
 * not be read (reported; the switch is not affected).
 */
export async function countOrganizationPasskeyHolders(
  admin: AdminClient,
  organizationId: string,
): Promise<number | null> {
  try {
    return (await countPasskeyHolders(admin, [organizationId])).get(organizationId) ?? 0;
  } catch (e) {
    await reportError(e, { tag: 'platform.passkeys.count_holders', extra: { organizationId } });
    return null;
  }
}

export interface PlatformPasskeySwitches {
  passkeysOn: boolean;
  passkeyAddsOn: boolean;
  /** False when the one settings row does not exist yet (everything off). */
  rowExists: boolean;
}

export interface OrganizationWithPasskeysOn {
  id: string;
  /** Null when the organization's name could not be read. */
  name: string | null;
  switchedOnAt: string;
  /** Null when the count could not be read. */
  membersWithPasskeys: number | null;
}

export interface PasskeyConsoleState {
  /** Null when the settings row could not be read: shown as unknown, never as off. */
  switches: PlatformPasskeySwitches | null;
  /** Null when the switch rows could not be read. Newest first. */
  organizations: OrganizationWithPasskeysOn[] | null;
}

/** What the console's Passkeys section shows. Every failed read is reported and shown as unknown. */
export async function readPasskeyConsole(): Promise<PasskeyConsoleState> {
  const admin = createAdminClient();

  let switches: PlatformPasskeySwitches | null = null;
  const settingsRead = await admin
    .from('platform_settings')
    .select('passkeys_on, passkey_adds_on')
    .eq('id', true)
    .maybeSingle();
  if (settingsRead.error) {
    await reportError(new Error(settingsRead.error.message), {
      tag: 'platform.passkeys.read_settings',
    });
  } else {
    const row = settingsRead.data as { passkeys_on?: unknown; passkey_adds_on?: unknown } | null;
    switches = {
      passkeysOn: row?.passkeys_on === true,
      passkeyAddsOn: row?.passkey_adds_on === true,
      rowExists: row !== null,
    };
  }

  let organizations: OrganizationWithPasskeysOn[] | null = null;
  try {
    const rows = await fetchAllRows<{ organization_id: string; switched_on_at: string }>(
      (from, to) =>
        admin
          .from('organization_passkey_switches')
          .select('organization_id, switched_on_at')
          .order('switched_on_at', { ascending: false })
          .order('organization_id')
          .range(from, to),
      { requireList: 'organization_passkey_switches' },
    );
    const ids = rows.map((r) => r.organization_id);

    const names = new Map<string, string>();
    try {
      const orgRows = await fetchAllRowsByIds<{ id: string; name: string }>(
        ids,
        (batch) => (from, to) =>
          admin
            .from('organizations')
            .select('id, name')
            .in('id', batch)
            .order('id')
            .range(from, to),
        { requireList: 'organizations' },
      );
      for (const o of orgRows) names.set(o.id, o.name);
    } catch (e) {
      await reportError(e, { tag: 'platform.passkeys.read_org_names' });
    }

    let counts: Map<string, number> | null = null;
    try {
      counts = await countPasskeyHolders(admin, ids);
    } catch (e) {
      await reportError(e, { tag: 'platform.passkeys.count_holders' });
    }

    organizations = rows.map((r) => ({
      id: r.organization_id,
      name: names.get(r.organization_id) ?? null,
      switchedOnAt: r.switched_on_at,
      membersWithPasskeys: counts ? (counts.get(r.organization_id) ?? 0) : null,
    }));
  } catch (e) {
    await reportError(e, { tag: 'platform.passkeys.read_switches' });
  }

  return { switches, organizations };
}

/** The most organizations the console's "Turn on for an organization" finder loads. */
export const PASSKEY_ORGANIZATION_CHOICES_CAP = 2000;

/**
 * Every organization by name, for the console's "Turn on for an
 * organization" finder (it filters in the browser). At most
 * PASSKEY_ORGANIZATION_CHOICES_CAP; `capped` says when there were more. Null
 * when the read failed (reported).
 */
export async function listOrganizationsForPasskeys(): Promise<{
  organizations: Array<{ id: string; name: string }>;
  capped: boolean;
} | null> {
  try {
    const rows = await fetchAllRows<{ id: string; name: string }>(
      (from, to) =>
        createAdminClient()
          .from('organizations')
          .select('id, name')
          .order('name')
          .order('id')
          .range(from, to),
      { cap: PASSKEY_ORGANIZATION_CHOICES_CAP + 1, requireList: 'organizations' },
    );
    const capped = rows.length > PASSKEY_ORGANIZATION_CHOICES_CAP;
    return {
      organizations: capped ? rows.slice(0, PASSKEY_ORGANIZATION_CHOICES_CAP) : rows,
      capped,
    };
  } catch (e) {
    await reportError(e, { tag: 'platform.passkeys.list_organizations' });
    return null;
  }
}

/**
 * Whether one organization has passkeys on: true, false, or null when the
 * switch row could not be read (reported; shown as unknown, never as off).
 */
export async function readOrganizationPasskeysOn(organizationId: string): Promise<boolean | null> {
  const { data, error } = await createAdminClient()
    .from('organization_passkey_switches')
    .select('organization_id')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    await reportError(new Error(error.message), {
      tag: 'platform.passkeys.read_organization',
      extra: { organizationId },
    });
    return null;
  }
  return data !== null;
}
