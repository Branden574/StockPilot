/**
 * The action-inventory rule of plan 8.5 ("glass exposes no action that
 * classic lacks anywhere on the same route, behind the same permission gate,
 * and classic exposes no action that glass lacks"), as a pure comparison of
 * two inventories, for action-inventory.spec.ts. An inventory is the list
 * ops-aria-actions.ts actionsOf() reads from an ARIA snapshot: one entry per
 * action, `role "name"`, a link with ` -> target`, sorted, repeats kept.
 *
 * What glass may add or drop is only what glass-only-allowlist.json lists for
 * the route (read as it is; this file never changes it):
 *  - a "renamed action" counts as its classic name (the header menu's
 *    trigger: "Appearance: design and theme" is "Toggle theme");
 *  - a glass-only action of an entry with a role and a name (a "duplicate
 *    action", a "public page link", a "presentation control", a "disclosure"
 *    button, an "appearance control") is allowed on the entry's routes and
 *    widths; for a "duplicate action" and a "public page link" its classic
 *    twin must be there in Classic for this same user (TWIN_RULES), else the
 *    glass action is reported: the twin missing for this role;
 *  - a classic action glass lacks is allowed only where an entry says glass
 *    replaces it: "replaced below a width" (a glass action of the same role
 *    goes to the same target), "moved into a menu below a width" (the menu,
 *    opened by the spec, holds the item), "hidden in a width band";
 *  - every other difference fails, in either direction.
 *
 * No Playwright import: the unit test (src/test/stage5a-actions.test.ts)
 * proves the rule on hand-written inventories.
 */

export interface AllowlistReplaced {
  role: string;
  selector?: string;
  name: string;
  href?: string;
}

export interface AllowlistEntry {
  id: string;
  kind: string;
  routes: string[];
  selector?: string;
  role?: string;
  name?: string;
  href?: string;
  minWidth?: number;
  maxWidth?: number;
  replaces?: AllowlistReplaced[];
  reveals?: { role: string; name: string; gate: string | null }[];
  classicTwin: string | null;
  gate: string | null;
}

export interface Allowlist {
  entries: AllowlistEntry[];
}

export interface ParsedAction {
  role: string;
  name: string;
  target: string | null;
  /** The entry as actionsOf wrote it. */
  raw: string;
}

const ACTION = /^([a-z]+) ("(?:[^"\\]|\\.)*")(?: -> (.*))?$/u;

/** One actionsOf entry, read back. */
export function parseAction(raw: string): ParsedAction {
  const match = ACTION.exec(raw);
  if (!match) return { role: raw, name: '', target: null, raw };
  return {
    role: match[1]!,
    name: JSON.parse(match[2]!) as string,
    target: match[3] ?? null,
    raw,
  };
}

/** The path of an action's target without its query or hash. */
function targetPath(target: string | null): string | null {
  if (target === null) return null;
  try {
    return new URL(target, 'http://x.invalid').pathname;
  } catch {
    return target;
  }
}

/**
 * Whether a concrete pathname is one of an entry's routes: `[x]` is one path
 * segment, a trailing `/**` one or more segments, anything else exact; one
 * trailing slash is ignored.
 */
export function routeMatches(pattern: string, path: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/$/u, '') : p);
  const source = trim(pattern)
    .split('/')
    .map((segment) => {
      if (segment === '**') return '.+';
      if (/^\[[^\]]+\]$/u.test(segment)) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}$`, 'u').test(trim(path));
}

/**
 * A name or target as the allowlist writes it, as a pattern: `<n>` a count,
 * any other `<...>` one or more characters without a slash.
 */
export function textPattern(text: string): RegExp {
  const parts = text.split(/(<[^>]+>)/u).map((part) => {
    if (part === '<n>') return '[0-9][0-9,]*';
    if (/^<[^>]+>$/u.test(part)) return '[^/]+';
    return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  });
  return new RegExp(`^${parts.join('')}$`, 'u');
}

/**
 * Names the allowlist describes in words rather than as the accessible name
 * (its `replaces` names are written for a reader). Keyed by entry id; each
 * pattern is the accessible name exactly.
 */
export const REPLACED_NAME_PATTERNS: Record<string, RegExp> = {
  // "What’s new (or 'What’s new, <n> unread')"
  'account-menu-whats-new': /^What’s new(?:, [0-9]+ unread)?$/u,
};

/**
 * The classic twin of a glass-only duplicate, as something the Classic
 * inventory of the same user on the same route must hold (plan 8.5: "an
 * allowlisted one whose classic twin is missing for that role" fails).
 */
export const TWIN_RULES: Record<
  string,
  { needs: string; holds(classic: ParsedAction[]): boolean }
> = {
  'sidebar-place-an-order': {
    needs: 'the sidebar’s Orders link (/dashboard/orders), behind the same gate',
    holds: (classic) =>
      classic.some((a) => a.role === 'link' && targetPath(a.target) === '/dashboard/orders'),
  },
  'auth-contact-the-team': {
    needs: 'the StockPilot home link (/)',
    holds: (classic) => classic.some((a) => a.role === 'link' && targetPath(a.target) === '/'),
  },
  'auth-help-security': {
    needs: 'the StockPilot home link (/)',
    holds: (classic) => classic.some((a) => a.role === 'link' && targetPath(a.target) === '/'),
  },
  'item-book-order-totals': {
    needs: 'the sidebar’s Reports link (/dashboard/reports)',
    holds: (classic) =>
      classic.some((a) => a.role === 'link' && targetPath(a.target) === '/dashboard/reports'),
  },
};

/** The kinds whose glass action needs its classic twin in Classic. */
const TWIN_KINDS = new Set(['duplicate action', 'public page link (no data action)']);

/**
 * The role and name an entry's glass-only action has, when the entry says it
 * only by selector (the external pages' appearance corner is the header
 * menu's trigger, named for glass).
 */
const SELECTOR_ONLY_ACTIONS: Record<string, { role: string; name: RegExp }[]> = {
  'external-appearance-menu': [{ role: 'button', name: /^Appearance: design and theme$/u }],
};

export interface Situation {
  /** The concrete pathname of the page compared. */
  path: string;
  /** The window's width in CSS px. */
  width: number;
}

function applies(entry: AllowlistEntry, at: Situation): boolean {
  if (!entry.routes.some((route) => routeMatches(route, at.path))) return false;
  if (entry.minWidth !== undefined && at.width < entry.minWidth) return false;
  if (entry.maxWidth !== undefined && at.width > entry.maxWidth) return false;
  return true;
}

export interface InventoryDiff {
  /** Glass-only actions no entry allows, or allowed without their classic twin. */
  extraInGlass: string[];
  /** Classic actions glass lacks that no entry lets it lack. */
  missingInGlass: string[];
  /** Glass-only actions an entry allowed, with the entry's id. */
  allowed: string[];
}

/** Multiset difference a - b. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Compares a route's inventories. `menuItems` are the actions the spec found
 * inside menus it opened in glass because an entry of kind "moved into a menu
 * below a width" applies (the closed menu's items are not in the tree).
 */
export function compareInventories(
  classicRaw: readonly string[],
  glassRaw: readonly string[],
  allowlist: Allowlist,
  at: Situation,
  menuItems: readonly string[] = [],
): InventoryDiff {
  const entries = allowlist.entries.filter((entry) => applies(entry, at));
  const renames = entries.filter(
    (e) => e.kind === 'renamed action' && e.role && e.name && e.classicTwin,
  );
  const glassNormalised = glassRaw.map((raw) => {
    const action = parseAction(raw);
    const rename = renames.find((e) => e.role === action.role && e.name === action.name);
    if (!rename) return raw;
    return `${action.role} ${JSON.stringify(rename.classicTwin)}${
      action.target === null ? '' : ` -> ${action.target}`
    }`;
  });
  const classic = classicRaw.map(parseAction);
  const glass = glassNormalised.map(parseAction);

  const extra = minus(glassNormalised, classicRaw).map(parseAction);
  const missing = minus(classicRaw, glassNormalised).map(parseAction);

  const extraInGlass: string[] = [];
  const allowed: string[] = [];
  for (const action of extra) {
    const entry = entries.find((e) => {
      if (e.kind === 'renamed action') return false;
      if (e.role && e.name) {
        if (e.role !== action.role || !textPattern(e.name).test(action.name)) return false;
        if (e.href && !(action.target && textPattern(e.href).test(targetPath(action.target)!)))
          return false;
        return true;
      }
      if (e.role && e.href) {
        return (
          e.role === action.role &&
          action.target !== null &&
          textPattern(e.href).test(targetPath(action.target)!)
        );
      }
      return (SELECTOR_ONLY_ACTIONS[e.id] ?? []).some(
        (s) => s.role === action.role && s.name.test(action.name),
      );
    });
    if (!entry) {
      extraInGlass.push(action.raw);
      continue;
    }
    if (TWIN_KINDS.has(entry.kind)) {
      const rule = TWIN_RULES[entry.id];
      if (!rule) {
        extraInGlass.push(`${action.raw} (allowlist ${entry.id}: no twin rule to check)`);
        continue;
      }
      if (!rule.holds(classic)) {
        extraInGlass.push(
          `${action.raw} (allowlist ${entry.id}: its classic twin, ${rule.needs}, is missing in Classic for this user)`,
        );
        continue;
      }
    }
    allowed.push(`${action.raw} [${entry.id}]`);
  }

  const missingInGlass: string[] = [];
  for (const action of missing) {
    const covered = entries.some((e) => {
      if (e.kind === 'replaced below a width') {
        const replaced = (e.replaces ?? []).some((r) => r.role === action.role);
        return (
          replaced &&
          action.target !== null &&
          glass.some(
            (g) => g.role === action.role && targetPath(g.target) === targetPath(action.target),
          )
        );
      }
      if (e.kind === 'moved into a menu below a width') {
        const pattern = REPLACED_NAME_PATTERNS[e.id];
        const replaced = (e.replaces ?? []).some(
          (r) =>
            r.role === action.role &&
            (pattern ? pattern.test(action.name) : textPattern(r.name).test(action.name)),
        );
        return (
          replaced && menuItems.map(parseAction).some((m) => m.role === e.role && m.name === e.name)
        );
      }
      if (e.kind === 'hidden in a width band (target on screen)') {
        return e.role === action.role && !!e.name && textPattern(e.name).test(action.name);
      }
      return false;
    });
    if (!covered) missingInGlass.push(action.raw);
  }

  return { extraInGlass, missingInGlass, allowed };
}

/** The entries whose glass-only action the spec must open a menu to see at this size. */
export function menusToOpen(allowlist: Allowlist, at: Situation): AllowlistEntry[] {
  return allowlist.entries.filter(
    (e) => e.kind === 'moved into a menu below a width' && applies(e, at),
  );
}

/** The "disclosure" buttons the spec presses in glass before it reads the inventory. */
export function disclosuresToPress(allowlist: Allowlist, at: Situation): AllowlistEntry[] {
  return allowlist.entries.filter(
    (e) => e.kind === 'disclosure of classic actions (no action)' && applies(e, at),
  );
}
