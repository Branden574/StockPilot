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
 * The token (`?t=`) is required because the GET endpoint scopes the
 * lookup to a single org. We DON'T render the org name on this page —
 * doing so would make the token-leak case worse. The status payload
 * itself comes back redacted, so even with a token + id + matching
 * email an attacker only learns the requester's own state.
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
