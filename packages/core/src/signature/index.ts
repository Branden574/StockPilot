export interface SignaturePoint { x: number; y: number }

export function pointsToSvgPath(points: SignaturePoint[]): string {
  if (points.length < 1) return '';
  const first = points[0] as SignaturePoint;
  const rest = points.slice(1);
  const start = `M ${first.x} ${first.y}`;
  const lines = rest.map(p => `L ${p.x} ${p.y}`).join(' ');
  return rest.length > 0 ? `${start} ${lines}` : start;
}

export const SIGNATURE_DATA_URL_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

export function isValidSignatureDataUrl(s: string): boolean {
  return SIGNATURE_DATA_URL_RE.test(s);
}
