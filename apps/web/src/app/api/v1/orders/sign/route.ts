// Alias of /api/orders/sign under the /api/v1 namespace.
//
// The mobile app (a React-Native, non-browser client) gets bot-challenged by
// Vercel's firewall on the bare /api/orders/sign path → a 429 "Security
// Checkpoint" HTML page. The org's firewall has a Bypass rule for /api/v1*, so
// routing the app's signature submit through this alias lets it reach our
// handler. The public web sign page (/orders/sign/[token]) keeps calling
// /api/orders/sign directly — a real browser passes the challenge.
// Same handler, same behavior; see reference_mobile_blocked_by_vercel_botprotection.
//
// NOTE: route-segment config (`runtime`/`dynamic`) must be declared INLINE here
// — Next.js/Turbopack statically parses these and refuses a re-export
// (`export { runtime } from …` fails the build). Only the POST handler is
// re-exported.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { POST } from '../../../orders/sign/route';
