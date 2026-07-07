import { DEFAULT_MODULE_IDS, type ModuleId, type Permission } from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import {
  activeTabShouldRedirect,
  allowedTabIds,
  chosenTabSlots,
  DEFAULT_TAB_SLOTS,
  MAX_TAB_SLOTS,
  MIN_TAB_SLOTS,
  resolveTabConfig,
  sanitizeStoredSlots,
  TAB_CANDIDATES,
  TAB_SLOT_IDS,
  type TabSlotId,
} from './tab-config';

/** All candidates allowed — the common case for gating-agnostic rules. */
const ALL = new Set<TabSlotId>(TAB_SLOT_IDS);

const ALL_MODULES = new Set<string>(DEFAULT_MODULE_IDS as readonly ModuleId[]);

function modulesWithout(...off: string[]): Set<string> {
  const s = new Set(ALL_MODULES);
  for (const m of off) s.delete(m);
  return s;
}

describe('candidate registry invariants', () => {
  it('TAB_SLOT_IDS and TAB_CANDIDATES are 1:1', () => {
    expect(TAB_CANDIDATES.map((c) => c.id)).toEqual([...TAB_SLOT_IDS]);
  });

  it('the default config is EXACTLY today’s visible bar, in today’s order (cycle-counts stays hidden by default)', () => {
    expect(DEFAULT_TAB_SLOTS).toEqual(['inventory', 'books', 'receive', 'scan']);
    expect(DEFAULT_TAB_SLOTS.length).toBeGreaterThanOrEqual(MIN_TAB_SLOTS);
    expect(DEFAULT_TAB_SLOTS.length).toBeLessThanOrEqual(MAX_TAB_SLOTS);
  });

  it('the max bound fits all five legacy non-Home tabs', () => {
    expect(MAX_TAB_SLOTS).toBeGreaterThanOrEqual(5);
  });

  it('Home is not a candidate — it is pinned, never a slot', () => {
    expect((TAB_SLOT_IDS as readonly string[]).includes('index')).toBe(false);
  });
});

describe('resolveTabConfig — stored-config rules', () => {
  it('null / undefined stored → default', () => {
    expect(resolveTabConfig(null, ALL)).toEqual([...DEFAULT_TAB_SLOTS]);
    expect(resolveTabConfig(undefined, ALL)).toEqual([...DEFAULT_TAB_SLOTS]);
  });

  it('corrupt stored (non-array shapes) → default', () => {
    for (const corrupt of ['garbage', 42, {}, { slots: ['scan'] }, true]) {
      expect(resolveTabConfig(corrupt, ALL)).toEqual([...DEFAULT_TAB_SLOTS]);
    }
  });

  it('unknown / stale ids and non-strings are silently dropped', () => {
    expect(
      resolveTabConfig(['inventory', 'bogus-tab', 42, null, 'scan'], ALL),
    ).toEqual(['inventory', 'scan']);
  });

  it('Home is never accepted into the slot list', () => {
    expect(resolveTabConfig(['index', 'inventory', 'scan'], ALL)).toEqual([
      'inventory',
      'scan',
    ]);
  });

  it('duplicates collapse to the first occurrence, preserving order', () => {
    expect(
      resolveTabConfig(['scan', 'inventory', 'scan', 'inventory'], ALL),
    ).toEqual(['scan', 'inventory']);
  });

  it('order is preserved exactly as stored', () => {
    const stored: TabSlotId[] = ['reports-tab', 'scan', 'orders-tab', 'inventory'];
    expect(resolveTabConfig(stored, ALL)).toEqual(stored);
  });

  it('a surviving list below the minimum heals to defaults', () => {
    expect(resolveTabConfig(['inventory'], ALL)).toEqual([...DEFAULT_TAB_SLOTS]);
    // Unknown ids dropped first, THEN the min check.
    expect(resolveTabConfig(['inventory', 'stale-id'], ALL)).toEqual([
      ...DEFAULT_TAB_SLOTS,
    ]);
    expect(resolveTabConfig([], ALL)).toEqual([...DEFAULT_TAB_SLOTS]);
  });

  it('clamps to the maximum of 5 slots', () => {
    const six: TabSlotId[] = [
      'inventory',
      'books',
      'receive',
      'scan',
      'cycle-counts',
      'orders-tab',
    ];
    expect(resolveTabConfig(six, ALL)).toEqual(six.slice(0, MAX_TAB_SLOTS));
  });

  it('gating intersection filters disallowed ids while preserving order', () => {
    const allowed = new Set<TabSlotId>(['inventory', 'scan', 'orders-tab']);
    expect(
      resolveTabConfig(['orders-tab', 'books', 'inventory', 'receive'], allowed),
    ).toEqual(['orders-tab', 'inventory']);
  });

  it('gating may shrink the bar below the minimum (today’s default already does when modules are off)', () => {
    const allowed = new Set<TabSlotId>(['inventory', 'scan']);
    // Default config with books+receiving gated off → Items + Scan, exactly
    // today's bar for such an org.
    expect(resolveTabConfig(null, allowed)).toEqual(['inventory', 'scan']);
  });

  it('a fully gated-out custom config falls back to the gated default instead of a Home-only bar', () => {
    const allowed = new Set<TabSlotId>(['inventory', 'scan']);
    expect(resolveTabConfig(['books', 'receive'], allowed)).toEqual([
      'inventory',
      'scan',
    ]);
  });
});

describe('chosenTabSlots — the raw CHOICE list (no gating, ever)', () => {
  it('returns the validated stored list untouched by gating', () => {
    const stored: TabSlotId[] = ['reports-tab', 'scan', 'orders-tab', 'inventory'];
    expect(chosenTabSlots(stored)).toEqual(stored);
  });

  it('falls back to the raw defaults when nothing usable is stored', () => {
    expect(chosenTabSlots(null)).toEqual([...DEFAULT_TAB_SLOTS]);
    expect(chosenTabSlots('garbage')).toEqual([...DEFAULT_TAB_SLOTS]);
    expect(chosenTabSlots(['scan'])).toEqual([...DEFAULT_TAB_SLOTS]); // below min heals
  });

  it('drops unknown ids + Home, dedupes, and clamps to the max', () => {
    expect(chosenTabSlots(['index', 'scan', 'junk', 'books', 'scan'])).toEqual([
      'scan',
      'books',
    ]);
    const six: TabSlotId[] = [
      'inventory',
      'books',
      'receive',
      'scan',
      'cycle-counts',
      'orders-tab',
    ];
    expect(chosenTabSlots(six)).toEqual(six.slice(0, MAX_TAB_SLOTS));
  });

  it('resolveTabConfig is exactly chosenTabSlots ∩ allowed (gating is render-time only)', () => {
    const stored: TabSlotId[] = ['orders-tab', 'inventory', 'scan'];
    const allowed = new Set<TabSlotId>(['inventory', 'scan']);
    expect(resolveTabConfig(stored, allowed)).toEqual(
      chosenTabSlots(stored).filter((id) => allowed.has(id)),
    );
  });
});

describe('choices are persisted, not the gating-filtered resolution', () => {
  // The transient-gating seam: orders module toggled off (or a
  // permissions-load race) while the user happens to edit something else.
  const storedChoice: TabSlotId[] = ['inventory', 'orders-tab', 'scan'];
  const ordersGatedOff = new Set<TabSlotId>(['inventory', 'books', 'receive', 'scan']);

  it('a transiently-gated chosen tab survives an unrelated edit', () => {
    // While gated, the bar hides Orders…
    expect(resolveTabConfig(storedChoice, ordersGatedOff)).toEqual([
      'inventory',
      'scan',
    ]);
    // …but the customize screen edits the RAW choice list. Simulate its edit
    // pipeline for an unrelated edit (add Books) exactly as the screen does:
    // working list = chosenTabSlots(stored), commit persists the raw result.
    const working = chosenTabSlots(storedChoice);
    const persisted = [...working, 'books' as TabSlotId];
    expect(persisted).toContain('orders-tab'); // NOT dropped by the edit
    // The bar still renders the gated view of the new choices…
    expect(resolveTabConfig(persisted, ordersGatedOff)).toEqual([
      'inventory',
      'scan',
      'books',
    ]);
    // …and Orders reappears in place the moment gating re-allows it.
    expect(resolveTabConfig(persisted, ALL)).toEqual([
      'inventory',
      'orders-tab',
      'scan',
      'books',
    ]);
  });

  it('reset stores the default ids raw — a module being off at reset time is not baked in', () => {
    // Reset = stored config gone (null tombstone). Resolving the reset config
    // must start from the RAW defaults, gated only at render time:
    const booksOff = new Set<TabSlotId>(['inventory', 'receive', 'scan']);
    expect(chosenTabSlots(null)).toEqual([...DEFAULT_TAB_SLOTS]); // books still chosen
    expect(resolveTabConfig(null, booksOff)).toEqual(['inventory', 'receive', 'scan']);
    // Module comes back → Books returns without any re-edit.
    expect(resolveTabConfig(null, ALL)).toEqual([...DEFAULT_TAB_SLOTS]);
  });
});

describe('activeTabShouldRedirect — the layout redirect guard decision', () => {
  const chosen: TabSlotId[] = ['inventory', 'orders-tab', 'scan'];
  const ordersGatedOff = new Set<TabSlotId>(['inventory', 'books', 'receive', 'scan']);

  it('never fires while either gate input is still loading — no transient state can redirect', () => {
    // Even a chosen-and-gated active tab must sit tight until role AND
    // effective permissions have both finished loading.
    expect(activeTabShouldRedirect('orders-tab', chosen, ordersGatedOff, false)).toBe(false);
    expect(activeTabShouldRedirect('orders-tab', chosen, new Set(), false)).toBe(false);
  });

  it('fires for a CHOSEN active tab that gating disallows once inputs are loaded', () => {
    expect(activeTabShouldRedirect('orders-tab', chosen, ordersGatedOff, true)).toBe(true);
  });

  it('does not fire for a chosen active tab that is still allowed', () => {
    expect(activeTabShouldRedirect('inventory', chosen, ordersGatedOff, true)).toBe(false);
    expect(activeTabShouldRedirect('scan', chosen, ALL, true)).toBe(false);
  });

  it('does not fire for an UNCHOSEN hidden tab — deep links render exactly as before, even when gated', () => {
    // cycle-counts is not in the chosen list and not allowed here: the
    // status-quo behavior (hidden via href:null but still renders, server
    // enforces real access) must be preserved — never bounce Home.
    expect(activeTabShouldRedirect('cycle-counts', chosen, ordersGatedOff, true)).toBe(false);
    expect(activeTabShouldRedirect('movements-tab', chosen, ordersGatedOff, true)).toBe(false);
  });

  it('ignores non-slot segments (Home, group segments, missing leaf)', () => {
    expect(activeTabShouldRedirect('index', chosen, ordersGatedOff, true)).toBe(false);
    expect(activeTabShouldRedirect('(tabs)', chosen, ordersGatedOff, true)).toBe(false);
    expect(activeTabShouldRedirect(undefined, chosen, ordersGatedOff, true)).toBe(false);
    expect(activeTabShouldRedirect(null, chosen, ordersGatedOff, true)).toBe(false);
  });
});

describe('sanitizeStoredSlots', () => {
  it('returns null for non-arrays and lists that heal below min-2', () => {
    expect(sanitizeStoredSlots('nope')).toBeNull();
    expect(sanitizeStoredSlots(null)).toBeNull();
    expect(sanitizeStoredSlots(['scan'])).toBeNull();
  });

  it('drops unknowns + Home, dedupes, preserves order', () => {
    expect(
      sanitizeStoredSlots(['index', 'scan', 'junk', 'books', 'scan']),
    ).toEqual(['scan', 'books']);
  });
});

describe('allowedTabIds — gating parity', () => {
  const owner = { role: 'owner' as const };

  it('with all modules on and an owner role, every candidate is allowed', () => {
    const allowed = allowedTabIds({ enabledModules: ALL_MODULES, ...owner });
    expect([...allowed].sort()).toEqual([...TAB_SLOT_IDS].sort());
  });

  it('legacy tabs keep the EXACT module-only gates of the old static layout', () => {
    // books off → Books tab gone; receiving off → POs tab gone.
    const allowed = allowedTabIds({
      enabledModules: modulesWithout('books', 'receiving'),
      ...owner,
    });
    expect(allowed.has('books')).toBe(false);
    expect(allowed.has('receive')).toBe(false);
    // Items + Scan are core: allowed even with an empty module set + viewer
    // role — identical to the old layout, which never gated them.
    const bare = allowedTabIds({ enabledModules: new Set(), role: 'viewer' });
    expect(bare.has('inventory')).toBe(true);
    expect(bare.has('scan')).toBe(true);
  });

  it('legacy module gates ignore permissions — the Books tab shows without items:read, exactly like today', () => {
    // Adversarial pixel-parity check: the drawer link for /books requires
    // items:read, but today's TAB gate is module-only. An effective
    // permission set WITHOUT items:read must not hide the default Books tab.
    const noPerms = new Set<Permission>();
    const allowed = allowedTabIds({
      enabledModules: ALL_MODULES,
      role: 'owner',
      permissions: noPerms,
    });
    expect(allowed.has('books')).toBe(true);
    expect(allowed.has('receive')).toBe(true);
    expect(allowed.has('inventory')).toBe(true);
    expect(allowed.has('scan')).toBe(true);
  });

  it('drawer-gated candidates disappear when their module is disabled', () => {
    const allowed = allowedTabIds({
      enabledModules: modulesWithout('orders', 'cycle_counts'),
      ...owner,
    });
    expect(allowed.has('orders-tab')).toBe(false);
    expect(allowed.has('cycle-counts')).toBe(false);
    // movements + reports are core-tier modules — still allowed for owner.
    expect(allowed.has('movements-tab')).toBe(true);
    expect(allowed.has('reports-tab')).toBe(true);
  });

  it('drawer-gated candidates respect the effective permission set (customization never widens access)', () => {
    // Owner role, but effective permissions revoke everything relevant →
    // the drawer hides those links, so the tabs must be disallowed too.
    const allowed = allowedTabIds({
      enabledModules: ALL_MODULES,
      role: 'owner',
      permissions: new Set<Permission>(['items:read']),
    });
    expect(allowed.has('orders-tab')).toBe(false);
    expect(allowed.has('movements-tab')).toBe(false);
    expect(allowed.has('reports-tab')).toBe(false);
    expect(allowed.has('cycle-counts')).toBe(false);
  });

  it('without an effective set, drawer gates fall back to the static role map — staff lacks activity_logs:read', () => {
    const allowed = allowedTabIds({
      enabledModules: ALL_MODULES,
      role: 'staff',
    });
    expect(allowed.has('movements-tab')).toBe(false); // staff: no activity_logs:read
    expect(allowed.has('reports-tab')).toBe(true); // staff: reports:read
    expect(allowed.has('orders-tab')).toBe(true); // staff: orders:request
    expect(allowed.has('cycle-counts')).toBe(true); // staff: stock:adjust
  });
});
