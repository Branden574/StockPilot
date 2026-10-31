import AsyncStorage from '@react-native-async-storage/async-storage';
import * as React from 'react';

import { accountEpoch, endAccountEpoch } from './account-epoch';
import { useAuth } from './auth-context';
import { cycleCountSync } from './cycle-count-sync';
import { deleteOrgData } from './db';
import { refreshEnabledModules } from './enabled-modules';
import { syncAfterRunning, syncNow } from './sync';
import { supabase } from './supabase';
import { chooseActiveOrg } from './workspace-choice';
import {
  readCacheRepairOwed,
  readOlderBuildWorkspaceSince,
  readSavedWorkspace,
  recordCacheRepairDone,
  recordCacheRepairOwed,
  saveWorkspace,
  savedWorkspaceFor,
} from './workspace-keys';

/**
 * Multi-org / multi-warehouse workspace state. Replaces the older
 * single-org assumption baked into `use-org.ts` by adding:
 *
 *   • full list of the user's accepted memberships (one per org),
 *   • the active org id, saved with the account that chose it as one value
 *     (workspace-keys.ts saveWorkspace),
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
  activeWarehouseId: string | null;
  activeWarehouseName: string | null;
}

const WAREHOUSE_STORAGE_KEY = (orgId: string) => `workspace.activeWarehouseId.${orgId}`;

const listeners = new Set<(state: WorkspaceState) => void>();
let cached: WorkspaceState = {
  loading: true,
  orgs: [],
  activeOrgId: null,
  activeOrgName: null,
  activeRole: null,
  warehouses: [],
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

/** How long a workspace load or a switch waits for the warehouse list. React
 *  Native's fetch has no timeout of its own: a switch waits for this read
 *  inside the switch queue, and a load holds `loading` until it answers, so a
 *  stalled request must not hold every later switch or a spinner. */
const WAREHOUSE_READ_TIMEOUT_MS = 15_000;

/** loadWarehouses, answered with null (as its error path does) when it fails
 *  or takes longer than WAREHOUSE_READ_TIMEOUT_MS. */
function loadWarehousesBounded(orgId: string): Promise<WarehouseOption[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[workspace] loadWarehouses timed out');
      resolve(null);
    }, WAREHOUSE_READ_TIMEOUT_MS);
    loadWarehouses(orgId).then(
      (rows) => {
        clearTimeout(timer);
        resolve(rows);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
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

/**
 * Cache repairs recorded as owed by this app since it started, by the
 * workspace load and the switch (workspace-keys.ts recordCacheRepairOwed).
 * The record is one value for the whole device, so a flow records it done
 * only while its own record is still the latest: another made since may stand
 * for a save that came after this flow's wipe was asked for, which that wipe
 * does not cover. That flow's own wipe records it done; if it fails, the next
 * load clears once more.
 */
let repairsRecorded = 0;

/** Record a cache repair as owed; the number of this record (see
 *  repairsRecorded). Counted as the write is asked for, before it lands: a
 *  removal asked for after that must see it, since AsyncStorage applies the
 *  two in the order they were asked for. */
async function recordRepairOwed(): Promise<number> {
  repairsRecorded += 1;
  const record = repairsRecorded;
  await recordCacheRepairOwed(AsyncStorage);
  return record;
}

/** Record the cache repair done, after a wipe that worked, when `record` (this
 *  flow's) is still the latest. A removal that fails leaves one more repair. */
async function recordRepairDone(record: number): Promise<void> {
  // Checked and asked for in one step, with no await between.
  if (record !== repairsRecorded) return;
  try {
    await recordCacheRepairDone(AsyncStorage);
  } catch (err) {
    console.warn(
      '[workspace] recording the cache repair done failed; the next load clears again',
      err,
    );
  }
}

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
  const [memberships, saved, profileDefault, repairOwed] = await Promise.all([
    loadOrgs(userId),
    readSavedWorkspace(AsyncStorage),
    loadProfileDefaultOrg(userId),
    // A cache repair an earlier load or switch could not finish (below).
    readCacheRepairOwed(AsyncStorage),
  ]);
  // Only this account's own saved workspace (docket B10): the one the request
  // header names (api.ts orgHeader). Another account's, left by a fallback
  // sign-out or a session the server ended, is not this account's choice even
  // where it is also a member, and choosing it while the first requests went
  // out without it would put the screen and the snapshot pull in two
  // workspaces.
  const persisted = savedWorkspaceFor(saved, userId);
  // A workspace an older app saved since this build last saved its own (a
  // rolled-back phone update, then this build again): read only to tell
  // whether the cache must be cleared (resetCache below). Unreadable counts as
  // none, as before this check.
  const olderBuildSince = await readOlderBuildWorkspaceSince(AsyncStorage).catch(() => null);
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
  // WHICH WORKSPACE THE CACHE HOLDS is not the same question as which one this
  // account chooses. Another account's saved workspace (persisted is null for
  // it) is not this account's choice, but the cache was pulled for it: that
  // account's requests named it until this account signed in. The choice,
  // told that nothing was saved, takes the cache to be the workspace the
  // server answers this account for with no header (its default, or its one
  // membership). So when this account chose another workspace, nothing was
  // cleared, and it was shown over the previous account's rows until this
  // account's own pull reset them (cache-owner.ts), a reset that waits for a
  // pull of the previous account's still out and clears the photos before
  // the rows (docket B10 review). Before B10 the saved workspace was the
  // cache's whoever saved it, and this load repaired. The cache is now kept
  // only when the other account's workspace and the one the server answers
  // this account for are both the one chosen.
  //
  // AFTER A ROLLED-BACK PHONE UPDATE the same holds for a workspace the older
  // app saved since this build last saved (workspace-keys.ts
  // readOlderBuildWorkspaceSince): the older app's pulls filled the cache
  // with it, while this build's own value, read first, is still the one from
  // before the rollback. This build then showed its own workspace over that
  // workspace's rows, which its delta pulls, from the older app's cursor,
  // never swept (docket B10 review).
  //
  // AND WHEN A REPAIR IS STILL OWED: one that an earlier load or a switch
  // recorded and whose wipe did not finish (below).
  const othersWorkspace = persisted === null ? saved.orgId : null;
  const resetCache =
    repairOwed ||
    choice.resetCache ||
    (othersWorkspace !== null && othersWorkspace !== activeOrgId) ||
    (olderBuildSince !== null && olderBuildSince !== activeOrgId);
  // THE REPAIR IS RECORDED AS OWED BEFORE ANYTHING ERASES ITS SIGNAL (docket
  // B10, integrator decision cache_clear_order). The save below replaces
  // another account's record and this account's record of a workspace it has
  // left, and removes the older app's key (workspace-keys.ts saveWorkspace),
  // and it runs before the wipe, so that a pull asked for after the wipe names
  // the workspace chosen. When the wipe then failed (it only warned), or the
  // app was closed while it waited its turn in the transaction queue, the
  // next load found no signal and cleared nothing, and the other workspace's
  // rows stayed: its purchase orders for good, since no pull sweeps them
  // (sync.ts). Now the record outlives the signal, and goes only once a wipe
  // has worked. Not recorded (storage failing), nothing is saved either: the
  // signal itself stays for the next load, as after a failed save.
  let repairRecord: number | null = null;
  if (activeOrgId && resetCache) {
    try {
      repairRecord = await recordRepairOwed();
    } catch (err) {
      console.warn(
        '[workspace] recording the cache repair failed; the saved workspace stays for the next load',
        err,
      );
    }
    // As after the reads above: when the account changed, or a switch
    // started, while the record was written, this load chooses nothing (the
    // switch's choice stands). The record stays, and the next load clears
    // once more.
    if (accountEpoch() !== epochAtStart) return;
    if (switchesStarted !== switchesAtStart) {
      publish({ loading: false, orgs });
      return;
    }
  }
  // EVERY LOAD THAT CHOOSES A WORKSPACE LEAVES IT SAVED AS THIS ACCOUNT'S
  // (integrator decision 3). Either it is saved here, with this account as its
  // owner, in one write (a new choice, a workspace saved by an older build
  // with no owner, or one saved over another account's), or the saved one
  // already is this account's own and is the one chosen (persist is false only
  // when the choice is the stored one, and the stored one is only ever this
  // account's or an older build's: savedWorkspaceFor). The outbox holds a row
  // with no workspace of its own until that is true (outbox-scope.ts
  // 'workspace-loading'). It is saved again when an older app's key sits
  // beside it: the save removes that key (integrator decision 3), so the
  // cache is cleared for it once. Not when the repair this load owes could
  // not be recorded (above): the save would erase its only record.
  let savedNow = false;
  if (
    activeOrgId &&
    (choice.persist || saved.ownerId !== userId || olderBuildSince !== null) &&
    (repairRecord !== null || !resetCache)
  ) {
    try {
      await saveWorkspace(AsyncStorage, activeOrgId, userId);
      savedNow = true;
    } catch (err) {
      // Still show the workspace (the server answers for the same default
      // when no header is saved); a failed save must not leave loading stuck.
      // The previous record stays whole (one write), and a held row waits for
      // the next load's save (each screen that mounts runs one).
      console.warn('[workspace] saving the chosen workspace failed', err);
    }
  }
  // The repair's wipe keeps the record of whose cache it is (cache-owner.ts):
  // this load can be the NEXT account's sign-in, with the previous account's
  // photos still on the device, and its pull must still find that account
  // recorded to clear them.
  if (activeOrgId && resetCache) {
    // The cache may hold another workspace's rows; clear the org-scoped
    // tables (never the outbox) and pull this workspace in full below.
    let wiped = false;
    try {
      await deleteOrgData();
      wiped = true;
    } catch (err) {
      // Still owed: the record stays, and the next load (any screen that
      // opens, the next launch) clears the cache again. This workspace is
      // still shown, as before: hiding it would leave every screen without
      // one while only the phone's own store is failing.
      console.warn('[workspace] the cache repair failed; it stays owed for the next load', err);
    }
    // Recorded done once this wipe has worked: it was asked for after this
    // load's save, so every pull that writes after it names the workspace
    // chosen (an answer asked for before it is discarded: db.ts
    // cacheGeneration). Only by a load that recorded it itself, while its
    // record is the latest (repairsRecorded) and its account and the switches
    // are still the ones it started with: a load of the next account, or a
    // switch, may have recorded a repair of its own meanwhile, for a save
    // this wipe does not cover. The record then stays, and the next load
    // clears once more.
    if (
      wiped &&
      repairRecord !== null &&
      accountEpoch() === epochAtStart &&
      switchesStarted === switchesAtStart
    ) {
      await recordRepairDone(repairRecord);
    }
  }
  if (savedNow) {
    // Rows held for want of this account's own workspace can go now: a pass
    // of each drain that STARTS after this save (sync.ts syncAfterRunning;
    // forceSync waits for a drain already running). The 60 s ticks and every
    // return to the foreground would send them too, up to a minute later.
    //
    // In a load that clears the cache, engine 1's one pass is the forced
    // full pull asked for below, once the workspace is shown: its drain sends
    // them (syncNow pulls, then drains), and a forced pull starts after any
    // sync running. Asked here too, that pass pulled the whole snapshot a
    // second time behind it (the wipe forgets the delta cursor, and a forced
    // pull never joins a sync running; docket B10 review).
    //
    // Both are asked for only once the repair's wipe above is done (the
    // merge with #380). Asked before it, a pass read whose cache this is and
    // the delta cursor with plain reads, which do not wait in the
    // transaction queue, while the wipe does: its owner check fell before or
    // after the wipe by timing, and the delta it fetched with the old cursor
    // could be discarded (sync.ts pullSnapshot, the cursor check), for one
    // when the wipe waited behind another queued transaction.
    if (!resetCache) void syncAfterRunning();
    void cycleCountSync.forceSync();
  }
  let warehouses: WarehouseOption[] = [];
  let activeWarehouseId: string | null = null;
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
    } else {
      warehouses = read ?? [];
      const persistedWh = await AsyncStorage.getItem(WAREHOUSE_STORAGE_KEY(activeOrgId));
      activeWarehouseId =
        persistedWh && warehouses.some((w) => w.id === persistedWh) ? persistedWh : null;
    }
  }
  if (accountEpoch() !== epochAtStart) return;
  if (switchesStarted !== switchesAtStart) {
    // A switch started during the warehouse read: same as above. A cache wipe
    // made here may have discarded the switch's own pull, so ask for another.
    publish({ loading: false, orgs });
    if (activeOrgId && resetCache) void syncNow(true).then(() => refreshEnabledModules());
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
    activeWarehouseId,
    activeWarehouseName: activeWarehouse?.name ?? null,
  });
  if (activeOrgId && resetCache) {
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
 */
export function retryWorkspace(): Promise<void> {
  if (retrying) return retrying;
  const userId = epochUserId;
  // A load already running (a screen that just mounted) answers the same way.
  if (!userId || cached.activeOrgId !== null || loadsRunning > 0) return Promise.resolve();
  publish({ loading: true });
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
  // Whose choice it is: the account signed in now (workspace-keys.ts). With
  // none known, nothing is saved and the switch fails. The first version
  // removed the owner then, which left a record every account's requests and
  // queued work trusted (integrator decision 3).
  const ownerId = epochUserId;
  if (!ownerId) throw new Error('No signed-in account to save the workspace for.');
  // The wipe below is owed from the moment the save replaces the workspace
  // the cache holds, and nothing else would tell the next load that it did
  // not finish (docket B10, as at the workspace load's repair; recurring
  // pattern 26). Recorded first; a record that cannot be written is a failed
  // switch, before anything is saved, wiped or shown. Recorded before the
  // switch is counted, so the count and the save below stay one step.
  const repairRecord = await recordRepairOwed();
  if (epoch !== accountEpoch()) return; // signed out meanwhile: save nothing
  switchesStarted += 1;
  // ONE write, the workspace with its owner. A failed save is a failed switch:
  // it throws here, before anything is wiped or shown, so the previous
  // workspace stays on screen and in storage. (A load that ran alongside only
  // refreshes the memberships, since switchesStarted moved: it shows nothing
  // new either.) Counted before the write, as before, so a load deciding at
  // the same moment either sees the switch or saves before it.
  await saveWorkspace(AsyncStorage, orgId, ownerId);
  // Multi-org device isolation: wipe the prior org's cached SQLite tables and
  // reset the delta cursor BEFORE the pull below. Without this, the local
  // items/POs/counts/bundles lists would transiently show the previous org's
  // rows, and pullSnapshot's `?since` cursor (from the prior org's timeline)
  // would be wrong. deleteOrgData deliberately preserves pending_actions: each
  // queued row carries its own organization and is sent under it (see
  // outbox-scope.ts), so nothing queued in the old workspace is lost or
  // replayed into the new one. It keeps this account's photos and the record
  // that the cache is this account's (cache-owner.ts): the account is the
  // same, and a pull for another account still finds it recorded.
  let wiped = false;
  try {
    await deleteOrgData();
    wiped = true;
  } catch (err) {
    // Still owed: the next load clears the cache before it shows a workspace.
    console.warn('[workspace] deleteOrgData on org switch failed; the next load clears again', err);
  }
  if (epoch !== accountEpoch()) return; // signed out mid-switch: show nothing
  // Recorded done as at the load, while this switch's record is the latest.
  // Not awaited: nothing may come between the check above and the publish
  // below (its check and its removal are asked for at once, and it reports
  // its own failure).
  if (wiped) void recordRepairDone(repairRecord);
  const orgRow = cached.orgs.find((o) => o.id === orgId) ?? null;
  shownEpoch = epoch;
  publish({
    activeOrgId: orgId,
    activeOrgName: orgRow?.name ?? null,
    activeRole: orgRow?.role ?? null,
    warehouses: [],
    activeWarehouseId: null,
    activeWarehouseName: null,
  });
  // A failed read leaves this new workspace with no warehouse list yet: there
  // is nothing of its own on screen to keep.
  const warehouses = (await loadWarehousesBounded(orgId)) ?? [];
  const persistedWh = await AsyncStorage.getItem(WAREHOUSE_STORAGE_KEY(orgId));
  const activeWarehouseId =
    persistedWh && warehouses.some((w) => w.id === persistedWh) ? persistedWh : null;
  const activeWarehouse = warehouses.find((w) => w.id === activeWarehouseId) ?? null;
  if (epoch !== accountEpoch()) return;
  publish({
    warehouses,
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
  if (!cached.activeOrgId) return;
  const key = WAREHOUSE_STORAGE_KEY(cached.activeOrgId);
  if (warehouseId === null) {
    await AsyncStorage.removeItem(key);
  } else {
    await AsyncStorage.setItem(key, warehouseId);
  }
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
