/**
 * The avatar hue a member keeps in Liquid Glass: one of the board's six
 * (.av.c1 to .c6 in the design's sp.css), picked from the member id so the
 * same person gets the same colour on every visit and wherever their row
 * sits. Classic never reads it: it only feeds the inert data-glass-hue hook
 * that pages/insights.css styles under the glass appearance.
 */
export const AVATAR_HUES = 6;

export function avatarHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return (h % AVATAR_HUES) + 1;
}
