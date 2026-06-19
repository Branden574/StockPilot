export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom';

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
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d;
    case 'custom': {
      const days =
        Number.isInteger(customDays) && (customDays as number) >= 1 ? (customDays as number) : 7;
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }
  }
}
