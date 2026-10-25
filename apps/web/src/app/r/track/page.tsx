import { ExternalHeader, ExternalShell } from '@/components/auth/external-shell';
import { TrackForm } from '@/components/orders/track-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The root layout's title template adds " · StockPilot" (CONFLICTS D15).
export const metadata = {
  title: 'Track your order',
  robots: { index: false, follow: false },
};

/**
 * Public order-tracking page.
 *
 * URL: `/r/track?t=<token>&id=<id>&email=<email>`
 *
 * The query params `id` and `email` come pre-filled in the confirmation
 * email + redirect after submit, but we also expose blank inputs so
 * someone with the tracking link can paste both in by hand.
 *
 * The token (`?t=`) is required: the GET endpoint
 * (api/v1/public/order-requests/[id]) accepts the request's own track token
 * (what the status emails embed, migration 0330), the organization's catalog
 * token or one of its order links' tokens, each only for an order of that
 * organization. We DON'T render the org name on this page — doing so would
 * make the token-leak case worse. The status payload itself comes back
 * redacted, so even with a token + id + matching email an attacker only
 * learns the requester's own state.
 *
 * Inactive links are accepted ON PURPOSE (923f8350c, #110): the token of an
 * order link that was turned off or has expired still opens this page and its
 * live map for the orders placed through it. Turning a link off stops new
 * requests through it; it must not strand an order someone already placed:
 * the key this page asks for when the URL carries none is that link's token
 * (the "Tracking link key" field), and status emails sent before migration
 * 0330 carry it too. The caller still needs the order id and the requester's
 * email, and only a read by the request's own track token gets the return
 * link. Making a turned-off link stop tracking too is a product decision:
 * add the filter to both routes and say so.
 */
export default async function PublicOrderTrackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialToken = stringParam(sp.t) ?? '';
  const initialId = stringParam(sp.id) ?? '';
  const initialEmail = stringParam(sp.email) ?? '';

  return (
    <ExternalShell frame="column" as="div" width="md">
      <ExternalHeader
        eyebrow="StockPilot"
        title="Track your order"
        description="Enter the email and request ID from your confirmation email."
        className="mb-6"
      />
      <TrackForm
        initialToken={initialToken}
        initialId={initialId}
        initialEmail={initialEmail}
      />
    </ExternalShell>
  );
}

function stringParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
