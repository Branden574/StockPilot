/**
 * WAREHOUSE EXCEPTIONS — the shared vocabulary for "something is quietly wrong".
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT A TASK QUEUE ═══
 *
 * Measured 2026-08-20: this warehouse has no backlog. One order in flight, five
 * hours old; nothing sitting in a non-terminal status; staging cleared inside
 * two days. Work arrives and gets done.
 *
 * What it has instead is undetected wrongness. On the same day, hand-written
 * SQL found 49 units unplaced for 55 days, two items whose printed label names
 * a rack holding none of their stock, and — for four weeks before anyone
 * noticed — 22 units sitting on a rack number the floor does not have.
 *
 * None of that was ever assigned to somebody and forgotten. A work queue
 * answers "who does what next", which is not the question. These are conditions
 * that are simply WRONG and that nothing surfaces. This module is the
 * vocabulary for surfacing them.
 *
 * EVERY RULE MUST BE ACTIONABLE. A rule that a reader cannot act on is a metric,
 * and metrics belong in reports. If the honest response to a row is "noted",
 * it does not go here — that is how an exception screen becomes a wall of noise
 * people stop opening, at which point it is worse than not existing.
 */

/**
 * Two levels, deliberately. A third ("info", "review") is where un-actionable
 * rows get filed to avoid deleting them, and the pile then trains people to
 * skim the whole screen.
 */
export type ExceptionSeverity = 'critical' | 'warning';

export type ExceptionRule =
  /** Positive stock on a location that has been archived. Counted, unreachable. */
  | 'orphaned_stock'
  /** More units promised to open orders than exist. A promise that cannot be kept. */
  | 'over_reserved'
  /** Received stock still in Staging well past a normal put-away. */
  | 'stale_staging'
  /** On hand, on no rack, for long enough that nobody is coming back for it. */
  | 'long_unplaced'
  /**
   * The item's printed label names somewhere its stock is not.
   *
   * Covers two shapes that production actually holds and that hurt identically:
   * a label naming the WRONG bay ("40-C" while the stock sits on 39-C), and a
   * label naming NO bay at all ("Bin"). A pick slip reading "Bin" routes a
   * picker exactly as well as one reading the wrong number — which is to say,
   * not at all — so both belong under one heading.
   */
  | 'label_mismatch';

export interface ExceptionRuleMeta {
  rule: ExceptionRule;
  severity: ExceptionSeverity;
  /** Group heading. Plural, because a group with one row still reads correctly. */
  label: string;
  /** What a reader should DO. Shown once per group, not per row. */
  action: string;
}

export const EXCEPTION_RULES: Record<ExceptionRule, ExceptionRuleMeta> = {
  orphaned_stock: {
    rule: 'orphaned_stock',
    severity: 'critical',
    label: 'Stock in an archived location',
    action:
      'These units still count toward on hand but the place they name is hidden from every picker, transfer and export. Move them to a live location.',
  },
  over_reserved: {
    rule: 'over_reserved',
    severity: 'critical',
    label: 'Promised more than is owned',
    action:
      'Open orders reserve more units than exist. At least one cannot be filled from stock — release a reservation or receive more.',
  },
  stale_staging: {
    rule: 'stale_staging',
    severity: 'warning',
    label: 'Sitting in Staging',
    action: 'Received but never put away. Place it on a rack so pickers can find it.',
  },
  long_unplaced: {
    rule: 'long_unplaced',
    severity: 'warning',
    label: 'On hand but on no rack',
    action:
      'Counted in stock with no location, long enough that nobody is coming back for it. Place it or write it off deliberately.',
  },
  label_mismatch: {
    rule: 'label_mismatch',
    severity: 'warning',
    label: 'Label will not lead to the stock',
    action:
      'The item’s printed label names somewhere its stock is not, so pick slips, shelf labels and the mobile lookup send people to the wrong place — or to nowhere at all.',
  },
};

/** One detected instance. Built by the service; rendered as-is. */
export interface WarehouseException {
  rule: ExceptionRule;
  /** Stable across reloads so React keys and future dismissals have an anchor. */
  key: string;
  /** The subject, in the warehouse's own words. */
  title: string;
  /** The specific numbers. Never a restatement of the rule. */
  detail: string;
  /** Where to go and fix it. Null only when no single page owns the fix. */
  href: string | null;
  units?: number;
  ageDays?: number;
}

const SEVERITY_ORDER: Record<ExceptionSeverity, number> = { critical: 0, warning: 1 };

/**
 * Order for display: severity first, then size, then age.
 *
 * SIZE BEFORE AGE IS DELIBERATE. Age is the more emotive number and the wrong
 * one to lead with — a single unit misplaced for 90 days sorts above 200 units
 * misplaced yesterday, and the reader fixes the trivia first. Units are what is
 * actually at stake; age breaks the tie.
 */
export function sortExceptions(list: readonly WarehouseException[]): WarehouseException[] {
  return [...list].sort((a, b) => {
    const sev =
      SEVERITY_ORDER[EXCEPTION_RULES[a.rule].severity] -
      SEVERITY_ORDER[EXCEPTION_RULES[b.rule].severity];
    if (sev !== 0) return sev;
    const units = (b.units ?? 0) - (a.units ?? 0);
    if (units !== 0) return units;
    const age = (b.ageDays ?? 0) - (a.ageDays ?? 0);
    if (age !== 0) return age;
    // Last resort so the order is TOTAL. Without this, two identical-looking
    // rows can swap places between renders and the list appears to flicker.
    return a.key.localeCompare(b.key);
  });
}

/** Grouped for rendering, in the same order, with empty groups omitted. */
export function groupExceptions(
  list: readonly WarehouseException[],
): Array<{ meta: ExceptionRuleMeta; items: WarehouseException[] }> {
  const sorted = sortExceptions(list);
  const out: Array<{ meta: ExceptionRuleMeta; items: WarehouseException[] }> = [];
  for (const e of sorted) {
    const existing = out.find((g) => g.meta.rule === e.rule);
    if (existing) existing.items.push(e);
    else out.push({ meta: EXCEPTION_RULES[e.rule], items: [e] });
  }
  return out;
}

/** Total across every rule — the number the nav badge and the header show. */
export function countExceptions(list: readonly WarehouseException[]): {
  total: number;
  critical: number;
} {
  let critical = 0;
  for (const e of list) if (EXCEPTION_RULES[e.rule].severity === 'critical') critical += 1;
  return { total: list.length, critical };
}
