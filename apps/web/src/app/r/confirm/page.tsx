import Link from 'next/link';

import { Button } from '@/components/ui/button';

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
 * GET must NOT consume the token. Corporate/school email security
 * scanners prefetch links within seconds of delivery (observed live
 * 2026-07-02 on the password-recovery flow: a one-time link consumed by
 * a GET 28s after send, before the human ever clicked). If this render
 * called the confirm RPC, a scanner would "confirm" the request with no
 * human involved — voiding the email-ownership signal the whole
 * pending_confirmation flow exists to capture (the manager queue only
 * sees rows the requester provably confirmed; see migration 0108 and
 * api/v1/public/order-requests). So:
 *   - GET renders a click-through page carrying the token in a hidden
 *     form. Scanners follow GET/HEAD but don't submit forms.
 *   - Only the form's POST (`/r/confirm/submit`) calls the
 *     `confirm_public_order_request` RPC that consumes the token.
 * Same pattern as /auth/confirm, which had the identical problem.
 * `force-dynamic` keeps the response out of any shared cache (no-store)
 * since the page body carries the one-time token; metadata sets noindex.
 *
 * Render states (all side-effect-free GETs):
 *   - id + t valid    → click-through "Confirm" panel.
 *   - ?done=<uuid>    → post-POST success panel (row promoted to
 *     pending_approval). Cosmetic — the real state lives in the DB.
 *   - ?e=1            → post-POST failure panel. Ambiguous on purpose;
 *     invalid / expired / already-used all render the same copy, so a
 *     second POST of a consumed token lands on "already used", not an
 *     error page, and we never tell a probing caller which check failed.
 *   - malformed query → same generic invalid panel.
 */
export default async function ConfirmOrderRequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const done = firstParam(sp.done);
  if (done && UUID_RE.test(done)) {
    return <ConfirmedPanel id={done} />;
  }
  if (firstParam(sp.e) !== null) {
    return <InvalidPanel />;
  }

  const id = firstParam(sp.id);
  const token = firstParam(sp.t);

  if (!id || !token || !UUID_RE.test(id) || !TOKEN_RE.test(token)) {
    return <InvalidPanel />;
  }

  return (
    <div className="mx-auto max-w-md py-6">
      <header className="text-center">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
          StockPilot
        </p>
        <h1 className="font-display mt-1 text-[26px] font-medium leading-tight tracking-[-0.025em]">
          Confirm your order request
        </h1>
        <p className="text-muted-foreground mt-3 text-sm">
          This link works once. Press the button below and we&apos;ll send
          your request to the team for review.
        </p>
      </header>
      <div className="bg-card border-border mt-6 rounded-xl border p-4 text-sm">
        <p className="text-muted-foreground text-xs">Request ID</p>
        <p className="font-mono break-all">{id}</p>
      </div>
      {/* Plain HTML form POST — zero JS, works in every mail-client
          browser, and (unlike a server action) survives a deploy between
          the email GET and the human's click. */}
      <form method="post" action="/r/confirm/submit" className="mt-6 text-center">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="t" value={token} />
        <Button type="submit">Confirm order request</Button>
      </form>
    </div>
  );
}

function ConfirmedPanel({ id }: { id: string }) {
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
          You&apos;ll get another email when a manager approves or declines it.
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
          We couldn&apos;t confirm this request
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
