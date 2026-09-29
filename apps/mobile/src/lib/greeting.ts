/**
 * The Home screen's greeting, by the time of day on the phone.
 *
 * Home used to say "Good morning," at every hour (the words were written into
 * the screen). It now reads the phone's own clock: morning before 12:00,
 * afternoon before 17:00 (5 PM), evening from 17:00 to midnight. Early hours
 * (midnight to noon) are morning.
 *
 * The phone's clock, not the organization's time zone: the greeting is for
 * the person holding the phone, where they are. (The web dashboard greets by
 * the organization's saved time zone, with its own hours; see NOTES in the
 * small-fixes work folder.)
 */

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Morning before 12:00, afternoon before 17:00, evening from 17:00. */
export function dayPartAt(date: Date): DayPart {
  const hour = date.getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** "Good morning," / "Good afternoon," / "Good evening," (the name follows). */
export function homeGreeting(date: Date): string {
  return `Good ${dayPartAt(date)},`;
}

/**
 * The next moment Home's words change: noon and 5 PM (the greeting) and
 * midnight (the date line, and the greeting back to morning). Home reads the
 * clock again then, so a Home screen left open all day, such as a shared
 * tablet that never goes to the background, keeps up.
 */
export function nextDayPartChange(date: Date): Date {
  const next = new Date(date);
  const hour = date.getHours();
  if (hour < 12) next.setHours(12, 0, 0, 0);
  else if (hour < 17) next.setHours(17, 0, 0, 0);
  else {
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
  }
  return next;
}
