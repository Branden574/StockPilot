import AsyncStorage from '@react-native-async-storage/async-storage';
import * as React from 'react';

import { accountEpoch, endAccountEpoch } from './account-epoch';
import { useAuth } from './auth-context';
import { deleteOrgData } from './db';
import { refreshEnabledModules } from './enabled-modules';
import { syncNow } from './sync';
import { supabase } from './supabase';
import { chooseActiveOrg } from './workspace-choice';
import { ACTIVE_ORG_STORAGE_KEY } from './workspace-keys';

/**
 * Multi-org / multi-warehouse workspace state. Replaces the older
 * single-org assumption baked into `use-org.ts` by adding:
 *
 *   • full list of the user's accepted memberships (one per org),
 *   • the active org id, persisted under ACTIVE_ORG_STORAGE_KEY (workspace-keys.ts),
 *   • full list of warehouses the user can read in the active org,
 *   • the active warehouse id (or `null` for "all warehouses"),
 *     persisted under `workspace.activeWarehouseId.<orgId>`.
 *
 * Mirrors the web app's `/dashboard` top-bar warehouse dropdown +
 * org-context plumbing — pick once on the drawer header, every list
 * screen narrows to that warehouse until you switch again.
 *
 * Subscribers can call `setActiveOrg` / `setActiveWarehouse` from the
 * switcher sheet; this hook re-renders every consumer through the
 * shared module state below.
 */

export interface OrgOption {
  id: string;
  name: string;
  role: string;
}

export interface WarehouseOption {
  id: string;
  name: string;
}

interface WorkspaceState {
  loading: boolean;
  orgs: OrgOption[];
  activeOrgId: string | null;
  activeOrgName: string | null;
  activeRole: string | null;
  warehouses: WarehouseOption[];
  /** The warehouse list is not one a read answered (it is loading, or its
   *  read failed or was slow): the switcher says so instead of "No warehouses
   *  in this org yet", and retryWorkspace reads it again (B24). */
  warehousesUnread: boolean;
  activeWarehouseId: string | null;
  activeWarehouseName: string | null;
}

const WAREHOUSE_STORAGE_KEY = (orgId: string) => `workspace.activeWarehouseId.${orgId}`;

/**
 * The saved warehouse's name, saved with its id as JSON `{ id, name }`: a
 * load whose warehouse read fails or is slow shows the saved warehouse by
 * this name (resolveWarehouses) instead of widening every list to all
 * warehouses. A `workspace.` key, so it is cleared with the others when the
 * account changes (account-eviction.ts).
 */
const WAREHOUSE_LABEL_STORAGE_KEY = (orgId: string) => `workspace.activeWarehouseLabel.${orgId}`;

const listeners = new Set<(state: WorkspaceState) => void>();
let cached: WorkspaceState = {
  loading: true,
  orgs: [],
  activeOrgId: null,
  activeOrgName: null,
  activeRole: null,
  warehouses: [],
  warehousesUnread: false,
  activeWarehouseId: null,
  activeWarehouseName: null,
};

function publish(next: Partial<WorkspaceState>) {
  cached = { ...cached, ...next };
  for (const fn of listeners) fn(cached);
}

/**
 * The user's accepted memberships, or null when the read FAILED (offline, a
 * dropped connection, a 5xx). A failed read is not "a member of nothing":
 * hydrate() keeps the workspace already on screen instead (see there).
 */
export async function loadOrgs(userId: string): Promise<OrgOption[] | null> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('role, organization_id, organizations:organization_id (name)')
    .eq('user_id', userId)
    .not('accepted_at', 'is', null);
  if (error) {
    console.warn('[workspace] loadOrgs failed:', error.message);
    return null;
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows
    .map((r) => {
      const orgField = r.organizations as { name?: string } | { name?: string }[] | null;
      const org = Array.isArray(orgField) ? orgField[0] : orgField;
      return {
        id: r.organization_id as string,
        name: (org?.name as string | undefined) ?? 'Workspace',
        role: r.role as string,
      };
    })
    .filter((o) => !!o.id);
}

/**
 * The organization's warehouses, or null when the read FAILED. A failed read
 * is not "no warehouses": hydrate() keeps the ones already on screen (see
 * there), as it keeps the workspace through a failed membership read.
 */
async function loadWarehouses(orgId: string): Promise<WarehouseOption[] | null> {
  const { data, error } = await supabase
    .from('warehouses')
    .select('id, name, status')
    .eq('organization_id', orgId)
    .order('name', { ascending: true });
  if (error) {
    console.warn('[workspace] loadWarehouses failed:', error.message);
    return null;
  }
  return ((data ?? []) as Array<{ id: string; name: string; status?: string | null }>)
    .filter((w) => (w.status ?? 'active') !== 'archived')
    .map((w) => ({ id: w.id, name: w.name }));
}

/** How long a workspace load or a switch waits for each of its reads: the
 *  memberships, the profile's default organization and the warehouse list.
 *  React Native's fetch has no timeout of its own: a switch waits for its
 *  warehouse read inside the switch queue, and a load holds `loading` until
 *  its reads answer, so a stalled request must not hold every later switch or
 *  a spinner. The membership and default reads had no bound at all (B24): one
 *  request that never answered kept every screen loading for good. */
const WORKSPACE_READ_TIMEOUT_MS = 15_000;

/** A workspace read, answered with null (as its error path does) when it
 *  fails or takes longer than WORKSPACE_READ_TIMEOUT_MS. */
function bounded<T>(name: string, read: () => Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[workspace] ${name} timed out`);
      resolve(null);
    }, WORKSPACE_READ_TIMEOUT_MS);
    read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function loadWarehousesBounded(orgId: string): Promise<WarehouseOption[] | null> {
  return bounded('loadWarehouses', () => loadWarehouses(orgId));
}

/** null is a failed read (loadOrgs): hydrate keeps the workspace on screen. */
function loadOrgsBounded(userId: string): Promise<OrgOption[] | null> {
  return bounded('loadOrgs', () => loadOrgs(userId));
}

/** null is "unset or unreadable", as loadProfileDefaultOrg answers an error. */
function loadProfileDefaultOrgBounded(userId: string): Promise<string | null> {
  return bounded('the default organization read', () => loadProfileDefaultOrg(userId));
}

/** The warehouse saved for an organization, with the name saved with it (null
 *  when none was, or it was saved for another warehouse). */
async function savedWarehouse(orgId: string): Promise<{ id: string; name: string | null } | null> {
  const [id, label] = await Promise.all([
    AsyncStorage.getItem(WAREHOUSE_STORAGE_KEY(orgId)),
    AsyncStorage.getItem(WAREHOUSE_LABEL_STORAGE_KEY(orgId)),
  ]);
  if (!id) return null;
  let name: string | null = null;
  try {
    const parsed = label ? (JSON.parse(label) as { id?: unknown; name?: unknown }) : null;
    if (parsed && parsed.id === id && typeof parsed.name === 'string' && parsed.name) {
      name = parsed.name;
    }
  } catch {
    // An unreadable label is no name: the read decides, as before.
  }
  return { id, name };
}

/** Save (or with null, clear) the name of an organization's saved warehouse.
 *  Never fails the caller: a label not saved only means a slow load cannot
 *  name the warehouse and shows all warehouses, as it did before. */
async function saveWarehouseLabel(orgId: string, warehouse: WarehouseOption | null): Promise<void> {
  try {
    if (warehouse) {
      await AsyncStorage.setItem(
        WAREHOUSE_LABEL_STORAGE_KEY(orgId),
        JSON.stringify({ id: warehouse.id, name: warehouse.name }),
      );
    } else {
      await AsyncStorage.removeItem(WAREHOUSE_LABEL_STORAGE_KEY(orgId));
    }
  } catch (err) {
    console.warn('[workspace] saving the warehouse name failed', err);
  }
}

/** What a workspace shows after its warehouse read (see resolveWarehouses). */
interface ResolvedWarehouses {
  warehouses: WarehouseOption[];
  activeWarehouseId: string | null;
  /** The list is not one a read answered: retryWorkspace reads it again. */
  unread: boolean;
}

/**
 * The warehouse list and the active warehouse after a warehouse read.
 *
 * A read that answered: its list, and the saved warehouse when it is in it,
 * else all warehouses. The saved name is brought up to date (an app that saved
 * only the id, or a renamed warehouse).
 *
 * A read that failed or was slow (null): the saved warehouse alone, by the
 * name saved with it, and the list marked unread. It used to be an empty list,
 * so the saved warehouse was "not in it" and every list quietly widened to all
 * warehouses on a slow first load (B24). With no name saved for it there is
 * nothing to show it by, and the workspace shows all warehouses, as before,
 * until the retry reads the list.
 */
async function resolveWarehouses(
  orgId: string,
  read: WarehouseOption[] | null,
): Promise<ResolvedWarehouses> {
  const saved = await savedWarehouse(orgId);
  if (read === null) {
    if (saved?.name) {
      return {
        warehouses: [{ id: saved.id, name: saved.name }],
        activeWarehouseId: saved.id,
        unread: true,
      };
    }
    return { warehouses: [], activeWarehouseId: null, unread: true };
  }
  const active = saved ? (read.find((w) => w.id === saved.id) ?? null) : null;
  if (active && active.name !== saved?.name) await saveWarehouseLabel(orgId, active);
  return { warehouses: read, activeWarehouseId: active?.id ?? null, unread: false };
}

/** The profile's default organization (the server's choice when a request
 *  names none), or null when unset or unreadable. */
async function loadProfileDefaultOrg(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('default_organization_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[workspace] default organization read failed:', error.message);
    return null;
  }
  return ((data as { default_organization_id: string | null } | null)?.default_organization_id ?? null) || null;
}

/** Switches that have started (see hydrate). */
let switchesStarted = 0;

/**
 * The account epoch the workspace on screen was chosen in (by a hydrate or a
 * switch), or null while none is shown. hydrate() keeps that workspace
 * through a failed membership read only when it belongs to the account still
 * signed in.
 */
let shownEpoch: number | null = null;

// A different account (or none) ends the account epoch the moment auth says
// so, before any screen reacts: a workspace load or switch still running for
// the previous account then saves and shows nothing. A token refresh keeps the
// same user id and ends nothing; the first event only records who is signed in.
let epochUserId: string | null | undefined;
supabase.auth.onAuthStateChange((_event, session) => {
  const id = session?.user?.id ?? null;
  if (epochUserId !== undefined && id !== epochUserId) endAccountEpoch();
  epochUserId = id;
});

/** Workspace loads running now (see retryWorkspace). */
let loadsRunning = 0;

async function hydrate(userId: string): Promise<void> {
  loadsRunning += 1;
  try {
    await loadWorkspace(userId);
  } finally {
    loadsRunning -= 1;
  }
}

async function loadWorkspace(userId: string) {
  const epochAtStart = accountEpoch();
  const switchesAtStart = switchesStarted;
  const [memberships, persisted, profileDefault] = await Promise.all([
    loadOrgsBounded(userId),
    AsyncStorage.getItem(ACTIVE_ORG_STORAGE_KEY),
    loadProfileDefaultOrgBounded(userId),
  ]);
  // See workspace-choice.ts: the same order the server uses, and the choice is
  // SAVED, so X-Organization-Id on every /api/v1 call names the workspace this
  // screen shows. Before, a choice made after sign-out lived only in memory and
  // the API answered for the default organization instead.
  // The account changed while these reads were out (sign-out, another user,
  // eviction): this load belongs to an account that is gone.
  if (accountEpoch() !== epochAtStart) return;
  // THE MEMBERSHIP READ FAILED (offline, a dropped connection). Every screen
  // that mounts runs this load, and a failed read used to count as "a member
  // of nothing": the workspace became null for the WHOLE APP, and every screen
  // reading with it stopped asking. On the phone's rental screens that was a
  // Try again that did nothing, or stayed disabled, after the connection came
  // back, until some other screen mounted online (simulator walk 2026-09-25).
  // So the workspace this account already has on screen stays, with its
  // warehouses: nothing new is chosen, saved or wiped, and every read made
  // with it is still answered by the server under the user's own access. With
  // no workspace yet for this account (a cold start offline), there is
  // nothing to keep and none is shown, as before.
  if (memberships === null && cached.activeOrgId !== null && shownEpoch === epochAtStart) {
    publish({ loading: false });
    return;
  }
  const orgs = memberships ?? [];
  // A switch made while these reads were out has already saved, wiped and
  // published its workspace. Deciding from the value read above would put the
  // screen back on the old workspace while every request and the cache use the
  // new one. The switch's choice stands; this only refreshes the memberships.
  if (switchesStarted !== switchesAtStart) {
    publish({ loading: false, orgs });
    return;
  }
  const choice = chooseActiveOrg({ orgIds: orgs.map((o) => o.id), stored: persisted, profileDefault });
  const activeOrgId = choice.activeOrgId;
  if (activeOrgId && choice.persist) {
    try {
      await AsyncStorage.setItem(ACTIVE_ORG_STORAGE_KEY, activeOrgId);
    } catch (err) {
      // Still show the workspace (the server answers for the same default
      // when no header is saved); a failed save must not leave loading stuck.
      console.warn('[workspace] saving the chosen workspace failed', err);
    }
  }
  if (activeOrgId && choice.resetCache) {
    // The cache may hold another workspace's rows; clear the org-scoped
    // tables (never the outbox) and pull this workspace in full below.
    try {
      await deleteOrgData();
    } catch (err) {
      console.warn('[workspace] deleteOrgData on workspace repair failed', err);
    }
  }
  let warehouses: WarehouseOption[] = [];
  let activeWarehouseId: string | null = null;
  let listUnread = false;
  if (activeOrgId) {
    // Bounded like a switch's read: a hung request must not hold `loading`.
    const read = await loadWarehousesBounded(activeOrgId);
    if (read === null && activeOrgId === cached.activeOrgId && shownEpoch === epochAtStart) {
      // THE WAREHOUSE READ FAILED for the workspace already on screen. It
      // used to count as "no warehouses": the saved warehouse was not in the
      // empty list, so the active warehouse became null for the whole app and
      // every list quietly widened to all warehouses. The same rule as a
      // failed membership read above: what this account already shows stays.
      warehouses = cached.warehouses;
      activeWarehouseId = cached.activeWarehouseId;
      listUnread = cached.warehousesUnread;
    } else {
      // A first load (or another workspace) has nothing of its own on screen
      // to keep: the saved warehouse is kept by its saved name instead.
      const resolved = await resolveWarehouses(activeOrgId, read);
      warehouses = resolved.warehouses;
      activeWarehouseId = resolved.activeWarehouseId;
      listUnread = resolved.unread;
    }
  }
  if (accountEpoch() !== epochAtStart) return;
  if (switchesStarted !== switchesAtStart) {
    // A switch started during the warehouse read: same as above. A cache wipe
    // made here may have discarded the switch's own pull, so ask for another.
    publish({ loading: false, orgs });
    if (activeOrgId && choice.resetCache) void syncNow(true).then(() => refreshEnabledModules());
    return;
  }
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;
  shownEpoch = activeOrgId ? epochAtStart : null;
  publish({
    loading: false,
    orgs,
    activeOrgId,
    activeOrgName: activeOrg?.name ?? null,
    activeRole: activeOrg?.role ?? null,
    warehouses,
    warehousesUnread: activeOrgId !== null && listUnread,
    activeWarehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
  if (activeOrgId && choice.resetCache) {
    void syncNow(true).then(() => refreshEnabledModules());
  }
}

/** The retry running now (see retryWorkspace). */
let retrying: Promise<void> | null = null;

/**
 * Load the workspace again when none is shown for the account signed in.
 *
 * A launch offline, or a failed first membership read after signing in,
 * leaves no workspace (hydrate keeps one only when this account already has
 * one on screen), and hydrate otherwise runs only when a screen mounts or the
 * session changes. A rental opened from a notification then spun with
 * nothing to tap after the connection came back (review 2026-09-26). The
 * rental screens' Try again calls this, and useSync calls it when the app
 * returns to the foreground, when the connection comes back and on each sync
 * tick.
 *
 * Nothing happens while a workspace is shown (a switch or a load chose it),
 * while a load is already running, or with nobody signed in. It is an
 * ordinary hydrate, so the account epoch and switch rules above apply to it
 * unchanged.
 *
 * Except: a workspace shown with a warehouse list that a failed or slow read
 * left unread (warehousesUnread, B24) is loaded again quietly, with no
 * spinner over the screen already showing it, so the list (and a saved
 * warehouse kept by name) is read once the connection allows.
 */
export function retryWorkspace(): Promise<void> {
  if (retrying) return retrying;
  const userId = epochUserId;
  // A load already running (a screen that just mounted) answers the same way.
  if (!userId || loadsRunning > 0) return Promise.resolve();
  const shown = cached.activeOrgId !== null;
  if (shown && !cached.warehousesUnread) return Promise.resolve();
  if (!shown) publish({ loading: true });
  const run = hydrate(userId)
    .catch((err: unknown) => {
      // A storage read that threw: the screen offers Try again again, never a
      // spinner that waits on a load that has ended.
      console.warn('[workspace] retrying the workspace load failed', err);
      if (cached.activeOrgId === null) publish({ loading: false });
    })
    .finally(() => {
      retrying = null;
    });
  retrying = run;
  return run;
}

/** Workspace switches in the order they were asked for (see setActiveOrg). */
let switchQueue: Promise<void> = Promise.resolve();

/**
 * Switches run one at a time. A switch saves the new workspace, then waits for
 * the cache wipe and the warehouse read before it publishes, so a second tap
 * in that window used to be lost (a re-tap of the still-highlighted workspace
 * returned early) or publish out of order. Now it waits its turn and then
 * applies: the last choice wins and is published last.
 */
export function setActiveOrg(orgId: string): Promise<void> {
  // A switch tapped for one account never runs for the next (see account-epoch).
  const epoch = accountEpoch();
  const run = switchQueue.then(() => (epoch === accountEpoch() ? switchActiveOrg(orgId, epoch) : undefined));
  switchQueue = run.catch(() => undefined);
  return run;
}

async function switchActiveOrg(orgId: string, epoch: number): Promise<void> {
  if (orgId === cached.activeOrgId) return;
  switchesStarted += 1;
  await AsyncStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
  // Multi-org device isolation: wipe the prior org's cached SQLite tables and
  // reset the delta cursor BEFORE the pull below. Without this, the local
  // items/POs/counts/bundles lists would transiently show the previous org's
  // rows, and pullSnapshot's `?since` cursor (from the prior org's timeline)
  // would be wrong. deleteOrgData deliberately preserves pending_actions: each
  // queued row carries its own organization and is sent under it (see
  // outbox-scope.ts), so nothing queued in the old workspace is lost or
  // replayed into the new one.
  try {
    await deleteOrgData();
  } catch (err) {
    console.warn('[workspace] deleteOrgData on org switch failed', err);
  }
  if (epoch !== accountEpoch()) return; // signed out mid-switch: show nothing
  const orgRow = cached.orgs.find((o) => o.id === orgId) ?? null;
  shownEpoch = epoch;
  publish({
    activeOrgId: orgId,
    activeOrgName: orgRow?.name ?? null,
    activeRole: orgRow?.role ?? null,
    warehouses: [],
    warehousesUnread: true,
    activeWarehouseId: null,
    activeWarehouseName: null,
  });
  // A failed read leaves this new workspace with no warehouse list yet: there
  // is nothing of its own on screen to keep.
  // So the warehouse saved for it is kept, by the name saved with it, and the
  // list is read again on the next retry (resolveWarehouses, B24). It used to
  // widen to all warehouses.
  const { warehouses, activeWarehouseId, unread } = await resolveWarehouses(
    orgId,
    await loadWarehousesBounded(orgId),
  );
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;
  if (epoch !== accountEpoch()) return;
  publish({
    warehouses,
    warehousesUnread: unread,
    activeWarehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
  // Pull a FULL snapshot scoped to the new org (api.ts sends
  // X-Organization-Id from the persisted activeOrgId). We pass force=true so
  // the pull ignores the prior org's `last_synced_at` cursor (just cleared by
  // deleteOrgData) and re-scopes every local table to the newly-active org.
  // Then notify useEnabledModules hooks so the drawer + tabs refresh without a
  // remount.
  //
  // Fire-and-forget: syncNow swallows its own errors, so on failure the refresh
  // simply doesn't fire and the (now-empty) cache is repopulated by the next
  // background sync — no unhandled rejection. The local tables were already
  // wiped above, so a failed pull leaves an empty cache for the NEW org rather
  // than stale rows from the PREVIOUS one.
  void syncNow(true).then(() => refreshEnabledModules());
}

export async function setActiveWarehouse(warehouseId: string | null): Promise<void> {
  const orgId = cached.activeOrgId;
  if (!orgId) return;
  const key = WAREHOUSE_STORAGE_KEY(orgId);
  if (warehouseId === null) {
    await AsyncStorage.removeItem(key);
  } else {
    await AsyncStorage.setItem(key, warehouseId);
  }
  // Its name with it, so a slow load can still show it (resolveWarehouses).
  await saveWarehouseLabel(orgId, cached.warehouses.find((w) => w.id === warehouseId) ?? null);
  const activeWarehouse = cached.warehouses.find((w) => w.id === warehouseId) ?? null;
  publish({
    activeWarehouseId: warehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
}

/**
 * React hook. Returns the live workspace state and triggers a hydrate
 * on first sign-in (or user-id change).
 */
export function useWorkspace(): WorkspaceState {
  const { user } = useAuth();
  const [state, setState] = React.useState<WorkspaceState>(cached);

  React.useEffect(() => {
    const fn = (next: WorkspaceState) => setState(next);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  React.useEffect(() => {
    if (!user) {
      shownEpoch = null;
      publish({
        loading: false,
        orgs: [],
        activeOrgId: null,
        activeOrgName: null,
        activeRole: null,
        warehouses: [],
        warehousesUnread: false,
        activeWarehouseId: null,
        activeWarehouseName: null,
      });
      return;
    }
    publish({ loading: true });
    void hydrate(user.id);
  }, [user]);

  return state;
}
