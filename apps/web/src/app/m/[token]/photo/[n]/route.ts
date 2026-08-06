import { NextResponse, type NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { hashShareToken, resolveMaintenanceSharePhoto } from '@/server/services/maintenance-share-links';

// createAdminClient()/checkRateLimit() need Node, not the edge runtime —
// matches /m/[token]/page.tsx's own declaration.
export const runtime = 'nodejs';
// Never cached/pre-rendered: authorization for this URL is "does the token
// still resolve right now", which can change between two requests for the
// exact same path (revoke, expiry).
export const dynamic = 'force-dynamic';

// Bucket id from migration 0315 — private, org-prefixed, no public SELECT
// policy. This route (plus MaintenanceAttachmentsService, which the
// authenticated dashboard uses) are the only places that ever read it, and
// always on the service-role client.
const BUCKET = 'maintenance-photos';

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Filesystem-safe Content-Disposition filename. Collapses to `[a-z0-9-]`
 *  like every other export/download route in the app (a newline or a
 *  double quote in a Content-Disposition value is a header-injection
 *  primitive — see `lib/exports/filename.ts`'s own sanitizer). The
 *  extension comes from the STORED mime type, not from the stored
 *  filename, which may already have lost its extension when IT was
 *  sanitized at upload time (`sanitizeFilenameSegment` collapses `.` to
 *  `-` too). */
function safeDownloadName(filename: string, mimeType: string): string {
  const base =
    filename
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'photo';
  const ext = EXT_FOR_MIME[mimeType] ?? 'jpg';
  return `${base}.${ext}`;
}

function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404 });
}

/**
 * Public, unauthenticated photo proxy for a maintenance-request share link
 * (fix wave C1 — the single Critical finding on this feature). Brief §10
 * forbids exposing storage paths to a public viewer; the page used to
 * render `createSignedUrl()` output directly into `<img src>`/`<a href>`,
 * which put the bucket name plus the org/request/attachment UUIDs in the
 * query string of every image on the page. This route is the fix: the page
 * renders ONLY `/m/<token>/photo/<n>` URLs, and this handler resolves the
 * token, downloads the object bytes on the SERVICE-ROLE client, and
 * streams them back directly — no signed URL, no storage path, no bucket
 * name, no UUID ever reaches the browser.
 *
 * Every miss — malformed token, malformed/out-of-range `n`, rate-limited,
 * or an unresolved token (unknown/revoked/expired — indistinguishable
 * upstream) — returns the SAME generic 404. Token/index probing learns
 * nothing here either, mirroring the page's own posture.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string; n: string }> },
) {
  const { token, n } = await params;

  // Route-boundary shape guards BEFORE spending any rate-limit budget or
  // calling the resolver — mirrors the page's own length guard. `n` must be
  // a bare non-negative integer; anything else (negative, decimal, huge,
  // non-numeric) is just another flavor of "not a valid photo reference".
  if (!token || token.length < 16 || token.length > 128) return notFound();
  if (!/^\d+$/.test(n)) return notFound();
  const index = Number(n);
  if (!Number.isSafeInteger(index)) return notFound();

  // Rate-limited on the SAME per-token bucket the page uses (C1 — a
  // scanner hammering photo indices for one token shares that token's
  // budget with hammering the page itself; keyed by the token's SHA-256,
  // never a raw/sliced token — fix wave m6) plus the repo's hardened
  // per-IP helper (fix wave I4). Same "unknown IP never collapses into one
  // global bucket" posture as the page: skip the IP check rather than let
  // every visitor whose IP we can't resolve share a single throttle that
  // one bad actor could trip for everyone.
  const ip = clientIpFromRequest(req);
  const checks = [
    checkRateLimit(`maintenance:share:token:${hashShareToken(token)}`, 120, 60 * 60 * 1000, 'closed'),
  ];
  if (ip !== 'unknown') {
    checks.push(checkRateLimit(`maintenance:share:ip:${ip}`, 60, 60 * 60 * 1000, 'closed'));
  }
  const results = await Promise.all(checks);
  if (results.some((r) => !r.allowed)) return notFound();

  const photo = await resolveMaintenanceSharePhoto(token, index);
  if (!photo) return notFound();

  const admin = createAdminClient();
  const { data: blob, error } = await admin.storage.from(BUCKET).download(photo.storagePath);
  if (error || !blob) return notFound();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  return new NextResponse(bytes as unknown as ArrayBuffer, {
    status: 200,
    headers: {
      // The STORED, sniffed-at-upload mime type
      // (MaintenanceAttachmentsService.finalize() writes it from
      // `sniffImage()`, never the client's declared Content-Type) — never
      // anything client-input-derived here.
      'Content-Type': photo.mimeType,
      'Content-Disposition': `inline; filename="${safeDownloadName(photo.filename, photo.mimeType)}"`,
      // Never cached by a shared/browser cache: this URL's authorization is
      // "does this specific request still resolve right now", which can
      // change (revoke, expiry) between two requests for the same path.
      'Cache-Control': 'private, no-store',
    },
  });
}
