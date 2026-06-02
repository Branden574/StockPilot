/** Pure geo helpers for live delivery tracking. No I/O. */
export interface LatLng { lat: number; lng: number; }

/** Great-circle distance in miles, rounded to 1 decimal. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.7613; // earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const miles = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(miles * 10) / 10;
}

/** A recorded location is stale if older than maxAgeSec (or unparseable). */
export function isStale(recordedAtIso: string, now: Date, maxAgeSec: number): boolean {
  const t = new Date(recordedAtIso).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > maxAgeSec * 1000;
}
