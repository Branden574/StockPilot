import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { checkRateLimit } from '@/lib/rate-limit';
import { resolveMaintenanceShareToken } from '@/server/services/maintenance-share-links';

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
export const metadata = {
  title: 'StockPilot maintenance request',
  robots: { index: false, follow: false },
};

/**
 * Public, unauthenticated maintenance-request share page — the "L4L/DC4 has
 * no StockPilot account but needs to see the photos" surface (maintenance
 * brief section 10). THE MOST DANGEROUS SURFACE IN THIS FEATURE: it renders
 * only what `resolveMaintenanceShareToken` hands back (an explicit allow-list
 * projection — see that function's own doc comment), and every miss —
 * unknown token, revoked link, expired link, malformed token, rate-limited
 * caller — renders the exact same generic 404 via `notFound()`. Token
 * probing learns nothing: no distinct "expired" vs "revoked" vs "not found"
 * page, no timing-obvious branch.
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
  // public endpoints). Both an IP bucket (one visitor hammering many tokens)
  // and a TOKEN bucket (many visitors/scanners hammering ONE token) are
  // enforced — either one tripping is enough to 404.
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const [ipLimit, tokenLimit] = await Promise.all([
    checkRateLimit(`maintenance:share:ip:${ip}`, 60, 60 * 60 * 1000, 'closed'),
    checkRateLimit(`maintenance:share:token:${token.slice(0, 32)}`, 120, 60 * 60 * 1000, 'closed'),
  ]);
  if (!ipLimit.allowed || !tokenLimit.allowed) notFound();

  const shared = await resolveMaintenanceShareToken(token);
  if (!shared) notFound();

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <p className="text-sm text-muted-foreground">StockPilot maintenance request</p>
        <h1 className="text-xl font-semibold">{shared.requestNumber}</h1>
        <p className="mt-1">{shared.subject}</p>
        {shared.siteName ? <p className="text-sm text-muted-foreground">Site: {shared.siteName}</p> : null}
      </header>
      <section>
        <h2 className="text-sm font-medium">Issue description</h2>
        <p className="mt-1 whitespace-pre-line text-sm">{shared.description}</p>
      </section>
      {shared.photos.length > 0 ? (
        <section>
          <h2 className="text-sm font-medium">Photos ({shared.photos.length})</h2>
          <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shared.photos.map((p) => (
              <li key={p.url}>
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  {/* Signed URLs are short-lived; plain img is correct here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.thumbUrl ?? p.url}
                    alt={p.filename}
                    className="h-32 w-full rounded-lg border object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer className="border-t pt-4 text-xs text-muted-foreground">
        This page shows one maintenance request shared from StockPilot. Internal notes are never shown here.
      </footer>
    </main>
  );
}
