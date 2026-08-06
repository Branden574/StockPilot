import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { clientIpFromHeaders } from '@/lib/client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { hashShareToken, resolveMaintenanceShareToken } from '@/server/services/maintenance-share-links';

// Never pre-rendered/cached — every request is a fresh, independent token
// resolution (a static/cached render could otherwise serve one visitor's
// resolved photos to another, or keep serving a revoked link past its
// revocation).
export const dynamic = 'force-dynamic';
// createAdminClient()/checkRateLimit() need Node, not the edge runtime —
// matches /r/[token]/page.tsx's own declaration.
export const runtime = 'nodejs';

// Static (no DB touch) — deliberately generic, and never indexed: this page
// carries no requester identity, but the request subject alone is still
// content that shouldn't turn up in search results or social-preview scrapes.
// (robots.ts also disallows the whole /m/ prefix — belt and braces.)
export const metadata = {
  title: 'StockPilot maintenance request',
  robots: { index: false, follow: false },
};

function formatSubmittedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** One labeled photo grid — used for both the requester "Photos" section
 *  and the "Resolution proof" section. `items` carries the ORIGINAL index
 *  from the combined `shared.photos` list (never a locally re-numbered
 *  index), so every `<img>`/`<a>` src stays the single `/m/<token>/photo/<i>`
 *  contract the proxy route enforces (spec §4.2) even though the two
 *  sections render disjoint SUBSETS of that one list. */
function PhotoGrid({
  token,
  heading,
  items,
}: {
  token: string;
  heading: string;
  items: Array<{ photo: { filename: string }; index: number }>;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-medium">
        {heading} ({items.length})
      </h2>
      <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map(({ photo, index }) => {
          // The ONLY photo URL this page ever renders: a same-origin proxy
          // path indexed by position in the COMBINED list, never a signed
          // storage URL (fix wave C1 — see the route's own doc comment).
          const src = `/m/${token}/photo/${index}`;
          return (
            <li key={`${photo.filename}-${index}`}>
              <a href={src} target="_blank" rel="noopener noreferrer">
                {/* The proxy sets Cache-Control: private, no-store; plain
                    img is correct here (no cross-origin optimizer to hand
                    this off to). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={photo.filename} className="h-32 w-full rounded-lg border object-cover" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Public, unauthenticated maintenance-request share page — the "L4L/DC4 has
 * no StockPilot account but needs to see the photos" surface (maintenance
 * brief section 10). THE MOST DANGEROUS SURFACE IN THIS FEATURE: it renders
 * only what `resolveMaintenanceShareToken` hands back (an explicit allow-list
 * projection — see that function's own doc comment) plus the photo PROXY
 * paths built from the array index — never a signed URL, storage path,
 * bucket name, or UUID (fix wave C1; bytes are streamed server-side by
 * `/m/[token]/photo/[n]/route.ts`). Every miss — unknown token, revoked
 * link, expired link, malformed token, rate-limited caller — renders the
 * exact same generic 404 via `notFound()`. Token probing learns nothing: no
 * distinct "expired" vs "revoked" vs "not found" page, no timing-obvious
 * branch.
 */
export default async function MaintenanceSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Route-boundary shape guard BEFORE spending any rate-limit budget or
  // calling the resolver — mirrors /r/[token]/page.tsx's own length guard.
  // The resolver applies its own (stricter, hex-only) check too; this is
  // defense-in-depth, not a substitute for it.
  if (!token || token.length < 16 || token.length > 128) notFound();

  // Unauthenticated public surface: rate-limit CLOSED (fail-closed on a DB
  // hiccup denies rather than opening the floodgates — acceptable here,
  // unlike an internal authenticated action, per the plan's posture for
  // public endpoints). Two independent buckets, either one tripping is
  // enough to 404:
  //   - a TOKEN bucket (many visitors/scanners hammering ONE token), keyed
  //     by the token's SHA-256 (never a raw/sliced token — fix wave m6) —
  //     shared with the photo proxy route, which keys off the exact same
  //     hash for the exact same token.
  //   - an IP bucket (one visitor hammering many tokens), resolved through
  //     the repo's hardened client-IP helper (fix wave I4) instead of a
  //     hand-rolled x-forwarded-for parse. When the IP can't be resolved
  //     (`'unknown'`), the bucket is SKIPPED rather than checked — the
  //     alternative collapses every visitor with no resolvable IP onto one
  //     shared counter, so a single such visitor could throttle everyone
  //     else in that bucket. The token bucket above is the real control in
  //     that case; losing the IP check for those visitors only, rather than
  //     gaining a global-DoS knob, is the trade-off.
  const h = await headers();
  const ip = clientIpFromHeaders(h);
  const rateLimitChecks = [
    checkRateLimit(`maintenance:share:token:${hashShareToken(token)}`, 120, 60 * 60 * 1000, 'closed'),
  ];
  if (ip !== 'unknown') {
    rateLimitChecks.push(checkRateLimit(`maintenance:share:ip:${ip}`, 60, 60 * 60 * 1000, 'closed'));
  }
  const rateLimitResults = await Promise.all(rateLimitChecks);
  if (rateLimitResults.some((r) => !r.allowed)) notFound();

  const shared = await resolveMaintenanceShareToken(token);
  if (!shared) notFound();

  // Split the ONE combined photo list into two labeled sections while
  // preserving each entry's ORIGINAL index — the proxy URL contract is
  // positional against the combined list (spec §4.2), so a section must
  // never re-number its own subset (that would desync `/photo/<i>` from
  // the photo it actually names — see T3-M3 in the task brief).
  const indexedPhotos = shared.photos.map((photo, index) => ({ photo, index }));
  const requesterPhotos = indexedPhotos.filter(({ photo }) => photo.kind === 'requester');
  const resolutionPhotos = indexedPhotos.filter(({ photo }) => photo.kind === 'resolution');

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <p className="text-sm text-muted-foreground">StockPilot maintenance request</p>
        <h1 className="text-xl font-semibold">{shared.requestNumber}</h1>
        <p className="mt-1">{shared.subject}</p>
        {shared.siteName ? <p className="text-sm text-muted-foreground">Site: {shared.siteName}</p> : null}
        <p className="text-sm text-muted-foreground">Submitted: {formatSubmittedDate(shared.createdAt)}</p>
      </header>
      <section>
        <h2 className="text-sm font-medium">Issue description</h2>
        <p className="mt-1 whitespace-pre-line text-sm">{shared.description}</p>
      </section>
      {shared.resolution ? (
        <section>
          <h2 className="text-sm font-medium">Resolution</h2>
          <p className="mt-1 text-sm text-muted-foreground">Marked resolved · {shared.resolution.resolvedAtDisplay}</p>
          <p className="mt-1 whitespace-pre-line text-sm">{shared.resolution.note}</p>
        </section>
      ) : null}
      <PhotoGrid token={token} heading="Photos" items={requesterPhotos} />
      <PhotoGrid token={token} heading="Resolution proof" items={resolutionPhotos} />
      <footer className="border-t pt-4 text-xs text-muted-foreground">
        This page shows one maintenance request shared from StockPilot. Internal notes are never shown here.
      </footer>
    </main>
  );
}
