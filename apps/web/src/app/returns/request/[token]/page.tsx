import { notFound } from 'next/navigation';

import { createAdminClient } from '@/lib/supabase/admin';
import { loadRequesterReturnContext } from '@/server/services/returns';

import { RequesterReturnForm } from './requester-return-form';

/**
 * Public requester-initiated return portal (Returns Phase B, B4).
 *
 * URL: `/returns/request/<token>` — anonymous, no auth. The token is the
 * per-order `order_requests.return_token` (0156); it is the ONLY auth the
 * visitor carries, and it scopes to EXACTLY ONE order. We resolve it with the
 * service-role admin client (the visitor has no JWT) and render ONLY that
 * order's still-returnable lines. No cross-order data is ever loaded or exposed.
 *
 * An unknown/expired token, a non-returnable order, or an org with the returns
 * module disabled all 404 silently (loadRequesterReturnContext returns null) so
 * we never leak which tokens are live.
 *
 * Mirrors the public order-request landing page (`/r/[token]`): bare layout,
 * noindex, force-dynamic, service-role read, token-as-auth.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return {
    title: 'Request a return',
    robots: { index: false, follow: false },
  };
}

export default async function RequesterReturnPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token) notFound();

  const admin = createAdminClient();
  const ctx = await loadRequesterReturnContext(admin, token);
  if (!ctx) notFound();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="border-border mb-8 border-b pb-6">
          <div className="text-primary mb-3 font-mono text-[11px] uppercase tracking-[0.18em]">
            Return request
          </div>
          <h1 className="font-display text-3xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-[34px]">
            Request a return
          </h1>
          <p className="text-muted-foreground mt-4 max-w-[56ch] text-sm leading-relaxed">
            Pick the items you&apos;d like to return and how many of each. The
            warehouse team reviews every request before anything is processed —
            you&apos;ll hear back once it&apos;s approved.
          </p>
        </header>

        {ctx.lines.length === 0 ? (
          <div className="border-border bg-card rounded-2xl border p-6 text-center">
            <h2 className="font-display text-lg">Nothing left to return</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              Every item on this order has already been returned, or this order
              has no returnable items. If you think this is a mistake, reach out
              to the warehouse directly.
            </p>
          </div>
        ) : (
          <RequesterReturnForm
            token={token}
            lines={ctx.lines}
            requesterName={ctx.requesterName}
          />
        )}

        <p className="text-muted-foreground mt-10 text-center text-[11px]">
          Powered by StockPilot
        </p>
      </main>
    </div>
  );
}
