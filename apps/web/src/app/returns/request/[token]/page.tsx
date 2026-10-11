import { headers } from 'next/headers';

import { RequesterTracking } from '@/components/returns/requester-tracking';
import { checkRateLimit } from '@/lib/rate-limit';
import { exchangeCreateEnabled } from '@/lib/returns/exchange-switch';
import { RETURN_PAGE_VIEWS_PER_IP_PER_HOUR, returnPageIpBucketKey } from '@/lib/returns/public-limits';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadRequesterReturnSheet } from '@/server/services/returns-requester';

import { RETURNS_COPY } from '@stockpilot/core';

import { RequesterReturnForm } from './requester-return-form';

/**
 * Public requester-initiated return portal (Returns Phase B, B4).
 *
 * URL: `/returns/request/<token>` — anonymous, no auth. The token is the
 * per-order return token (0156; in order_request_secrets since 0389/0392); it is the ONLY auth the
 * visitor carries, and it scopes to EXACTLY ONE order. We resolve it with the
 * service-role admin client (the visitor has no JWT) and render ONLY that
 * order's still-returnable lines. No cross-order data is ever loaded or exposed.
 *
 * Returns RX-3: the page is the requester's "Return or exchange" sheet
 * (loadRequesterReturnSheet: names, sizes and photos signed for the order's
 * own items, never a SKU), each line Return only or Exchange for another
 * size (the sizes come from a POST with the token in the body, on the first
 * Exchange), and "Your requests on this order" below it (the requester's own
 * requests in core's sentences; never a rack, Staging, a disposition, a
 * cost, a note, a reason or a staff name).
 *
 * An unknown/expired token, a non-returnable order, or an org with the returns
 * module disabled all 404 silently (loadRequesterReturnSheet returns null) so
 * we never leak which tokens are live.
 *
 * Mirrors the public order-request landing page (`/r/[token]`): bare layout,
 * noindex, force-dynamic, service-role read, token-as-auth.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return {
    title: exchangeCreateEnabled() ? RETURNS_COPY.requesterReturnOrExchange : 'Request a return',
    robots: { index: false, follow: false },
  };
}

export default async function RequesterReturnPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token) return <ReturnLinkInvalid />;

  // Per-IP limit on the page itself (returns RX-1), fail-closed like the
  // submit: a token-guessing crawl stops here before any lookup.
  const h = await headers();
  const xff = process.env.VERCEL === '1' ? h.get('x-forwarded-for') : null;
  const ip = xff?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  const limit = await checkRateLimit(
    returnPageIpBucketKey(ip),
    RETURN_PAGE_VIEWS_PER_IP_PER_HOUR,
    60 * 60 * 1000,
    'closed',
  );
  if (!limit.allowed) return <ReturnLinkBusy />;

  const admin = createAdminClient();
  const sheet = await loadRequesterReturnSheet(admin, token);
  // Unknown, expired, non-returnable, and module-off all render the SAME
  // return-branded dead-end (owner report 2026-07-20: the generic global 404
  // is too blunt for a page people reach from an email link). Deliberately
  // ONE message for every failure mode — no oracle about whether a token
  // ever existed. notFound() is not used so the copy can be return-specific.
  if (!sheet) return <ReturnLinkInvalid />;

  const exchanges = sheet.exchangesEnabled;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="border-border mb-8 border-b pb-6">
          <div className="text-primary mb-3 font-mono text-[11px] uppercase tracking-[0.18em]">
            Return request{sheet.orderNumber ? ` · Order ${sheet.orderNumber}` : ''}
          </div>
          <h1 className="font-display text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-[34px]">
            {exchanges ? RETURNS_COPY.requesterReturnOrExchange : 'Request a return'}
          </h1>
          <p className="text-muted-foreground mt-4 max-w-[56ch] text-sm leading-relaxed">
            {exchanges ? (
              <>
                Choose the items you&apos;re sending back and how many of each. For each one, choose{' '}
                {RETURNS_COPY.returnOnly} or {RETURNS_COPY.exchangeRequester}. The warehouse team reviews
                every request before anything happens, and this page shows where each request stands.
              </>
            ) : (
              <>
                Pick the items you&apos;d like to return and how many of each. The
                warehouse team reviews every request before anything is processed —
                you&apos;ll hear back once it&apos;s approved.
              </>
            )}
          </p>
        </header>

        <RequesterReturnForm
          token={token}
          lines={sheet.lines}
          exchangesEnabled={exchanges}
          requesterName={sheet.requesterName}
          hasRequests={sheet.tracking.length > 0}
        />

        <RequesterTracking requests={sheet.tracking} className="mt-10" id="your-requests" />

        <p className="text-muted-foreground mt-10 text-center text-[11px]">
          Powered by StockPilot
        </p>
      </main>
    </div>
  );
}

/**
 * Return-branded dead-end for an unusable link (unknown/expired token,
 * returns module off). Matches the live page's chrome so the requester
 * knows they reached the right SYSTEM, just with a dead link — and tells
 * them what to actually do next (contact whoever sent the order), which
 * the generic global 404 didn't.
 */
function ReturnLinkInvalid() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="border-border mb-8 border-b pb-6">
          <div className="text-primary mb-3 font-mono text-[11px] uppercase tracking-[0.18em]">
            Return request
          </div>
          <h1 className="font-display text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-[34px]">
            This return link isn&apos;t active
          </h1>
        </header>
        <div className="border-border bg-card rounded-2xl border p-6 text-center">
          <p className="text-muted-foreground mx-auto max-w-[52ch] text-sm leading-relaxed">
            The link may have been mistyped, or it&apos;s no longer available.
            If you received it by email and think this is a mistake, reply to
            that email or contact the team that fulfilled your order — they can
            start the return for you.
          </p>
        </div>
        <p className="text-muted-foreground mt-10 text-center text-[11px]">
          Powered by StockPilot
        </p>
      </main>
    </div>
  );
}

/** Too many page views from one address in an hour. */
function ReturnLinkBusy() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="border-border mb-8 border-b pb-6">
          <div className="text-primary mb-3 font-mono text-[11px] uppercase tracking-[0.18em]">
            Return request
          </div>
          <h1 className="font-display text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-[34px]">
            Too many requests
          </h1>
        </header>
        <div className="border-border bg-card rounded-2xl border p-6 text-center">
          <p className="text-muted-foreground mx-auto max-w-[52ch] text-sm leading-relaxed">
            This page was opened too many times from your network in the last hour. Wait a while and
            open your return link again.
          </p>
        </div>
      </main>
    </div>
  );
}
