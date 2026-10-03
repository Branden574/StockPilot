// Alias of /api/orders/[id]/signature under the /api/v1 namespace (migration
// 0389). The phone's "View signature" dialog reads the captured image through
// it instead of selecting signature_data_url from the table, so the image can
// leave the member-readable order row in slice C. A native (non-browser)
// client is bot-challenged by Vercel's firewall on the bare /api/orders path;
// the org's firewall bypasses /api/v1*, the same reason as
// /api/v1/orders/sign. Same handler, same gate (orders:approve or the
// assigned driver), same throttle.
//
// NOTE: route-segment config (`runtime`/`dynamic`) must be declared INLINE here
// — Next.js/Turbopack statically parses these and refuses a re-export. Only the
// GET handler is re-exported.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { GET } from '../../../../orders/[id]/signature/route';
