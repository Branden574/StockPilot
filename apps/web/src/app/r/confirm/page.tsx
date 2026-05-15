import { createHash } from 'node:crypto';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Confirm your order request · StockPilot',
  robots: { index: false, follow: false },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

/**
 * `/r/confirm?id=<uuid>&t=<hex>` — landing page for the click-to-
 * confirm link emailed to every public order requester.
 *
 * Why a server-rendered page rather than a JSON endpoint:
 *   * The recipient already has the URL in their inbox — let them
 *     click it directly from any device and see a friendly result.
 *   * No client-side state to worry about; the whole flow is one
 *     GET → RPC → render.
 *   * The token is consumed by the RPC even on bot prefetches
 *     (Outlook scanning, link-warmer crawlers). That's a deliberate
 *     tradeoff: the alternative — wait for an explicit "Confirm"
 *     button click — would let attackers DoS the confirmation window
 *     for victims behind aggressive link scanners. One-click confirm
 *     is the standard pattern for transactional emails.
 *
 * Render states:
 *   - success → row promoted to pending_approval; show a small
 *     "Confirmed!" panel.
 *   - already_confirmed / expired / invalid → ambiguous UI on
 *     purpose; we don't tell the user which check failed.
 *   - malformed query → same generic invalid page.
 */
export default async function ConfirmOrderRequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const id = firstParam(sp.id);
  const token = firstParam(sp.t);

  if (!id || !token || !UUID_RE.test(id) || !TOKEN_RE.test(token)) {
    return <InvalidPanel />;
  }

  // Hash before the RPC so the plaintext only ever lives in the URL
  // (which the recipient already has).
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('confirm_public_order_request', {
    p_id: id,
    p_token_hash: tokenHash,
  });

  if (error || !data) {
    return <InvalidPanel />;
  }

  return (
    <div className="mx-auto max-w-md py-6">
      <header className="text-center">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display mt-1 text-[26px] font-medium leading-tight tracking-[-0.025em]">
          Request confirmed
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          Thanks — your order request has been sent to the team for review.
          You'll get another email when a manager approves or declines it.
        </p>
      </header>
      <div className="bg-card border-border mt-6 rounded-xl border p-4 text-sm">
        <p className="text-muted-foreground text-xs">Request ID</p>
        <p className="font-mono break-all">{id}</p>
      </div>
      <div className="mt-6 text-center">
        <Link href="/r/track" prefetch={false}>
          <Button variant="outline">Track this request</Button>
        </Link>
      </div>
    </div>
  );
}

function InvalidPanel() {
  return (
    <div className="mx-auto max-w-md py-6">
      <header className="text-center">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display mt-1 text-[26px] font-medium leading-tight tracking-[-0.025em]">
          We couldn't confirm this request
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          This link is either invalid, expired, or already used. If you still
          need to place the order, submit a fresh request from the order page.
        </p>
      </header>
      <div className="mt-6 text-center">
        <Link href="/r/track" prefetch={false}>
          <Button variant="outline">Track an existing request</Button>
        </Link>
      </div>
    </div>
  );
}

function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
