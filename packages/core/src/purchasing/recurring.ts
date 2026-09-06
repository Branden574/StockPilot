export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom';

/**
 * Add `months` to a UTC date, CLAMPING the day to the last day of the target month.
 *
 * WHY (SP-044): `d.setUTCMonth(d.getUTCMonth() + 1)` keeps the day-of-month and lets
 * JS Date roll the overflow forward — 2026-01-31 + 1 month became 2026-03-03, and
 * 2025-11-30 + 3 months became 2026-03-02. Two consequences in production:
 *   1. A monthly template created on the 29th-31st SKIPPED a whole month (no
 *      February PO at all), because its next run jumped straight into March.
 *   2. `RecurringPosService.runDueTemplates` advances next_run_at by chaining
 *      `nextRunAt(cadence, previousNextRun)`, so the rolled-over day became the
 *      new anchor and the PO date kept sliding month after month, with no UI
 *      field and no update() path to correct it.
 * Clamping keeps a month-end template firing on the last day of a short month
 * instead of leaking into the next one.
 *
 * KNOWN LIMIT (deliberate): the clamp is lossy — once Jan 31 clamps to Feb 28 the
 * following month is Mar 28, not Mar 31. Restoring the original day-of-month needs
 * an `anchor_day` column on recurring_po_templates; deferred. The clamp alone
 * removes the skipped month and the perpetual forward drift.
 */
function addUtcMonthsClamped(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  // Day 0 of the month AFTER the target = the target month's last day.
  const daysInTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(from.getUTCDate(), daysInTargetMonth);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/** Compute the next run timestamp from a base date. Pure (no Date.now). */
export function nextRunAt(cadence: RecurringCadence, from: Date, customDays?: number): Date {
  const d = new Date(from.getTime());
  switch (cadence) {
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case 'biweekly':
      d.setUTCDate(d.getUTCDate() + 14);
      return d;
    // Month cadences clamp instead of rolling over — see addUtcMonthsClamped (SP-044).
    case 'monthly':
      return addUtcMonthsClamped(from, 1);
    case 'quarterly':
      return addUtcMonthsClamped(from, 3);
    case 'custom': {
      const days =
        Number.isInteger(customDays) && (customDays as number) >= 1 ? (customDays as number) : 7;
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }
  }
}
