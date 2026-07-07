import {
  resolveSurface,
  type ModuleId,
  type Permission,
  type Role,
} from '@stockpilot/core';

/**
 * User-customizable bottom tab bar — pure config logic (no React, no native
 * modules, so vitest covers every rule).
 *
 * The bar is always Home + 2–5 user-chosen slots. The DEFAULT config is
 * EXACTLY today's out-of-the-box bar: Home, Items, Books, POs, Scan — with
 * Books/POs gated by their modules the same way (tabs)/_layout.tsx has always
 * gated them. A user who never opens Settings → Customize tab bar sees a bar
 * that is pixel-for-pixel identical to before this feature existed; the
 * customize screen is purely opt-in adjustment on top.
 *
 * Two gate kinds, deliberately different:
 *   • 'always' / 'module' — the five legacy tabs keep the EXACT gating the
 *     old static layout applied (module enablement only, never permissions),
 *     so the default bar cannot change out from under an existing user.
 *   • 'drawer' — tabs that are new to the bar (Cycle Counts, Orders,
 *     Movements, Reports, and the drawer-parity batch: Categories, Tags,
 *     Rentals, Purchase orders, PO imports, Locations, Suppliers,
 *     Procedures) reuse the drawer's own gating engine
 *     (resolveSurface: module on + role + effective permission), so adding a
 *     tab can never widen access beyond what the drawer already shows.
 *
 * Note: like the drawer, tab visibility is COSMETIC nav gating — real access
 * control is server-side (assertModuleEnabled / assertPermission + RLS).
 */

/** Every route that can occupy a user slot. Ids ARE the expo-router route
 *  names inside app/(drawer)/(tabs)/ — the layout maps them 1:1 to
 *  `<Tabs.Screen name>`. Home ('index') is pinned and never a slot. */
export const TAB_SLOT_IDS = [
  'inventory',
  'books',
  'receive',
  'scan',
  'cycle-counts',
  'orders-tab',
  'movements-tab',
  'reports-tab',
  'categories-tab',
  'tags-tab',
  'rentals-tab',
  'purchase-orders-tab',
  'po-imports-tab',
  'locations-tab',
  'suppliers-tab',
  'procedures-tab',
] as const;

export type TabSlotId = (typeof TAB_SLOT_IDS)[number];

/** The pinned first tab. Never a slot; stripped from any stored config. */
export const HOME_TAB_ID = 'index';

/** Bounds for the user-chosen slot list (Home excluded). Max 5 keeps total
 *  density at 6 tabs — and comfortably fits all five legacy non-Home tabs. */
export const MIN_TAB_SLOTS = 2;
export const MAX_TAB_SLOTS = 5;

/**
 * EXACTLY today's visible bar, in today's order (Home is implicit first).
 * cycle-counts is NOT here — it is hidden (`href: null`) in today's layout,
 * so a default user must not suddenly grow a Counts tab.
 */
export const DEFAULT_TAB_SLOTS: readonly TabSlotId[] = [
  'inventory',
  'books',
  'receive',
  'scan',
];

type TabGate =
  | { kind: 'always' }
  | { kind: 'module'; moduleId: ModuleId }
  | { kind: 'drawer'; href: string };

export interface TabCandidate {
  id: TabSlotId;
  /** Short bottom-bar label (matches today's titles for the legacy tabs). */
  title: string;
  /** Full name shown in the customize screen list. */
  settingsLabel: string;
  gate: TabGate;
}

export const TAB_CANDIDATES: readonly TabCandidate[] = [
  // ── Legacy five: gating copied verbatim from the old static layout ──────
  { id: 'inventory', title: 'Items', settingsLabel: 'Items', gate: { kind: 'always' } },
  { id: 'books', title: 'Books', settingsLabel: 'Books', gate: { kind: 'module', moduleId: 'books' } },
  { id: 'receive', title: 'POs', settingsLabel: 'Receive POs', gate: { kind: 'module', moduleId: 'receiving' } },
  { id: 'scan', title: 'Scan', settingsLabel: 'Scan', gate: { kind: 'always' } },
  {
    id: 'cycle-counts',
    title: 'Counts',
    settingsLabel: 'Cycle counts',
    gate: { kind: 'drawer', href: '/cycle-counts' },
  },
  // ── Tab-wrapped drawer destinations (thin routes over the same screens) ─
  { id: 'orders-tab', title: 'Orders', settingsLabel: 'Orders', gate: { kind: 'drawer', href: '/orders' } },
  {
    id: 'movements-tab',
    title: 'Moves',
    settingsLabel: 'Movements',
    gate: { kind: 'drawer', href: '/movements' },
  },
  {
    id: 'reports-tab',
    title: 'Reports',
    settingsLabel: 'Reports',
    gate: { kind: 'drawer', href: '/reports' },
  },
  // ── Full drawer parity: every remaining list surface is choosable. Each
  //    gate is the drawer's OWN placement (module + role + effective
  //    permission via resolveSurface), so the tab shows iff the drawer link
  //    does. Titles are the short bar labels; the customize list always
  //    shows the full settingsLabel.
  {
    id: 'categories-tab',
    title: 'Categs',
    settingsLabel: 'Categories',
    gate: { kind: 'drawer', href: '/categories' },
  },
  { id: 'tags-tab', title: 'Tags', settingsLabel: 'Tags', gate: { kind: 'drawer', href: '/tags' } },
  {
    id: 'rentals-tab',
    title: 'Rentals',
    settingsLabel: 'Rentals',
    gate: { kind: 'drawer', href: '/rentals' },
  },
  {
    id: 'purchase-orders-tab',
    title: 'PO List',
    settingsLabel: 'Purchase orders',
    gate: { kind: 'drawer', href: '/purchase-orders' },
  },
  {
    id: 'po-imports-tab',
    title: 'Imports',
    settingsLabel: 'PO imports',
    gate: { kind: 'drawer', href: '/po-imports' },
  },
  {
    id: 'locations-tab',
    title: 'Places',
    settingsLabel: 'Locations',
    gate: { kind: 'drawer', href: '/locations' },
  },
  {
    id: 'suppliers-tab',
    title: 'Vendors',
    settingsLabel: 'Suppliers',
    gate: { kind: 'drawer', href: '/suppliers' },
  },
  {
    id: 'procedures-tab',
    title: 'SOPs',
    settingsLabel: 'Procedures',
    gate: { kind: 'drawer', href: '/procedures' },
  },
];

const CANDIDATE_BY_ID: ReadonlyMap<TabSlotId, TabCandidate> = new Map(
  TAB_CANDIDATES.map((c) => [c.id, c]),
);

export function tabCandidate(id: TabSlotId): TabCandidate {
  // TAB_SLOT_IDS and TAB_CANDIDATES are asserted 1:1 by tests.
  return CANDIDATE_BY_ID.get(id) as TabCandidate;
}

export function isTabSlotId(value: unknown): value is TabSlotId {
  return typeof value === 'string' && (TAB_SLOT_IDS as readonly string[]).includes(value);
}

export interface TabGateInput {
  /** From useEnabledModules() — same source the layout + drawer read. */
  enabledModules: ReadonlySet<string>;
  /** From useRole(); pass 'staff' while loading, exactly like drawer-content. */
  role: Role;
  /** From useEffectivePermissions(); undefined falls back to the static role
   *  map inside resolveSurface — identical to the drawer. */
  permissions?: ReadonlySet<Permission>;
}

/**
 * The set of candidate ids the current user/org may show in the bar.
 * 'drawer'-gated candidates are allowed iff the mobile drawer would render a
 * link to the same destination — literally the drawer's resolver, so
 * customization can never widen access.
 */
export function allowedTabIds(input: TabGateInput): Set<TabSlotId> {
  let drawerHrefs: Set<string> | null = null;
  const resolveDrawerHrefs = (): Set<string> => {
    if (drawerHrefs === null) {
      drawerHrefs = new Set(
        resolveSurface('mobile_drawer', {
          role: input.role,
          enabledModules: input.enabledModules as Set<ModuleId>,
          permissions: input.permissions,
        }).flatMap((section) => section.items.map((item) => item.href)),
      );
    }
    return drawerHrefs;
  };

  const out = new Set<TabSlotId>();
  for (const candidate of TAB_CANDIDATES) {
    const gate = candidate.gate;
    if (gate.kind === 'always') {
      out.add(candidate.id);
    } else if (gate.kind === 'module') {
      if (input.enabledModules.has(gate.moduleId)) out.add(candidate.id);
    } else if (resolveDrawerHrefs().has(gate.href)) {
      out.add(candidate.id);
    }
  }
  return out;
}

/**
 * Sanitizes a raw stored value (parsed JSON of unknown shape) into a valid
 * slot list, or null when the value is unusable and the caller should fall
 * back to defaults:
 *   • non-arrays / corrupt values → null
 *   • unknown or stale ids (and Home, and non-strings) are silently dropped
 *   • duplicates collapse to the first occurrence (order preserved)
 *   • a surviving list below MIN_TAB_SLOTS heals to null (→ defaults)
 */
export function sanitizeStoredSlots(stored: unknown): TabSlotId[] | null {
  if (!Array.isArray(stored)) return null;
  const seen = new Set<TabSlotId>();
  for (const value of stored) {
    if (isTabSlotId(value)) seen.add(value);
  }
  const slots = [...seen];
  return slots.length < MIN_TAB_SLOTS ? null : slots;
}

/**
 * The user's raw CHOSEN slot list — validated ids, order preserved, clamped
 * to MAX, healed to the default when unusable — with NO gating applied.
 *
 * This is what gets persisted and what the customize screen edits. Gating is
 * a render/preview-time concern only (resolveTabConfig): a chosen tab whose
 * module/permission is transiently off stays in the stored choice list, so an
 * unrelated edit can't permanently drop it and it reappears the moment gating
 * re-allows it.
 */
export function chosenTabSlots(stored: unknown): TabSlotId[] {
  const chosen = sanitizeStoredSlots(stored) ?? [...DEFAULT_TAB_SLOTS];
  return chosen.slice(0, MAX_TAB_SLOTS);
}

/**
 * The single resolve step the layout renders from:
 *   stored (raw, untrusted) → chosenTabSlots (sanitize/heal/clamp) → ∩ allowed.
 *
 * Gating BELOW the minimum is permitted (today's default bar already drops to
 * Home+Items+Scan when books+receiving are off) — but if gating empties the
 * list entirely, fall back to the gated default so the bar is never Home-only.
 * Home is pinned by the layout and never appears in the returned list.
 */
export function resolveTabConfig(
  stored: unknown,
  allowed: ReadonlySet<TabSlotId>,
): TabSlotId[] {
  const gated = chosenTabSlots(stored).filter((id) => allowed.has(id));
  if (gated.length > 0) return gated;
  return DEFAULT_TAB_SLOTS.filter((id) => allowed.has(id));
}

/**
 * Decision logic for the tab layout's active-tab redirect guard, extracted
 * pure so the rules are unit-tested:
 *
 *   • never before BOTH gate inputs (role + effective permissions) have
 *     finished loading — a transient 'staff' fallback or a static-role-map
 *     permission window must not yank anyone off their tab at cold start;
 *   • only for a tab the user CHOSE (raw choice list, pre-gating) that
 *     gating currently disallows — a deep link to an unchosen hidden tab
 *     (href: null, e.g. the drawer's cycle-counts) renders exactly as it
 *     always has instead of bouncing Home;
 *   • never for non-slot segments (Home/'index', group segments, undefined).
 */
export function activeTabShouldRedirect(
  active: string | null | undefined,
  chosen: readonly TabSlotId[],
  allowed: ReadonlySet<TabSlotId>,
  gatesLoaded: boolean,
): boolean {
  if (!gatesLoaded) return false;
  if (!isTabSlotId(active)) return false;
  if (!chosen.includes(active)) return false;
  return !allowed.has(active);
}
