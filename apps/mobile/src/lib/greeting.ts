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
