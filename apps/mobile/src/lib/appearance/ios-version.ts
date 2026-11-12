/** First iOS version with the Liquid Glass API (GlassView is a plain View below it). */
export const GLASS_MIN_IOS = 26;

/** The iOS major version from Platform.Version ('26.0' on iOS), or 0 when unreadable. */
export function iosMajor(version: string | number): number {
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) ? major : 0;
}
