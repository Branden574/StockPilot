import 'server-only';
import { haversineMiles, type LatLng } from '@stockpilot/core';

export { haversineMiles, type LatLng };

/**
 * Geocode a free-form address string via Nominatim (OSM, free, no key).
 * Returns null on any failure (caller fails soft → no destination marker).
 * Low volume only — callers MUST cache the result (we geocode each charter once).
 */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const q = address.trim();
  if (!q) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'StockPilot/1.0 (delivery-tracking)' } },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const first = arr[0];
    if (!first?.lat || !first?.lon) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/**
 * Turn a charter `address` jsonb into a single geocodable line. The stored
 * shape is charterAddressSchema: { line1, line2, city, region, postalCode, country }.
 */
export function addressToLine(address: unknown): string {
  if (!address || typeof address !== 'object') return '';
  const a = address as Record<string, unknown>;
  return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(', ');
}
