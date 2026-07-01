export interface SignaturePoint { x: number; y: number }

export function pointsToSvgPath(points: SignaturePoint[]): string {
  if (points.length < 1) return '';
  const first = points[0] as SignaturePoint;
  const rest = points.slice(1);
  const start = `M ${first.x} ${first.y}`;
  const lines = rest.map(p => `L ${p.x} ${p.y}`).join(' ');
  return rest.length > 0 ? `${start} ${lines}` : start;
}

/**
 * Quadratic-smoothed variant of {@link pointsToSvgPath}: each interior point
 * is a quadratic control point with segment midpoints as the on-curve anchors,
 * then a final straight line to the last captured point. Mirrors the web
 * canvas pad's quadraticCurveTo smoothing (signature-pad.tsx) so raw finger
 * polylines render as smooth ink.
 *
 * A SEPARATE function — pointsToSvgPath stays byte-exact (its unit test
 * asserts the exact M/L output, and other consumers rely on it). Falls back to
 * the plain builder for fewer than 3 points (nothing to smooth).
 */
export function pointsToSmoothSvgPath(points: SignaturePoint[]): string {
  if (points.length < 3) return pointsToSvgPath(points);
  const first = points[0] as SignaturePoint;
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const cur = points[i] as SignaturePoint;
    const next = points[i + 1] as SignaturePoint;
    const mx = (cur.x + next.x) / 2;
    const my = (cur.y + next.y) / 2;
    d += ` Q ${cur.x} ${cur.y} ${mx} ${my}`;
  }
  const last = points[points.length - 1] as SignaturePoint;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

export function isValidSignatureDataUrl(s: string): boolean {
  return SIGNATURE_DATA_URL_RE.test(s);
}
