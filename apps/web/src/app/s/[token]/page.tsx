import { cache } from 'react';

import { PublicSignaturePage } from '@/components/shipments/public-signature-page';
import { createAdminClient } from '@/lib/supabase/admin';

// M3: dedupe the work_order_number lookup that runs in BOTH
// generateMetadata and the page render. React.cache is per-request, so
// the page render that runs after generateMetadata reuses the result.
// This drops the page from 5 admin DB round-trips to 4.
const lookupShipmentByToken = cache(async (token: string) => {
  const admin = createAdminClient();
  const { data } = await admin
    .from('shipments')
    .select(
      'id, organization_id, work_order_number, status, ship_date, ' +
        'attention_to_name, signed_by_name, signed_at, signature_email_to, ' +
        'signature_token_expires_at, source_warehouse_id, destination_charter_id',
    )
    .eq('signature_token', token)
    .maybeSingle();
  return data;
});

const SIGNED_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public signature landing page.
 *
 * URL: `/s/<token>` — anyone with the link lands here. Anonymous, no auth.
 * Uses the service-role admin client because the visitor has no Supabase
 * JWT; the signature_token IS the auth (validated server-side here AND
 * again inside `submitShipmentSignatureAction` for defense in depth).
 *
 * Renders one of three states:
 *   1. Inactive link (bad token / expired / cancelled) → friendly card
 *   2. Already signed → "delivered" receipt confirmation
 *   3. Active → branded summary + <SignatureForm>
 */

interface ShipmentRow {
  id: string;
  organization_id: string;
  work_order_number: string;
  status: 'draft' | 'shipped' | 'delivered' | 'cancelled';
  ship_date: string;
  attention_to_name: string | null;
  signed_by_name: string | null;
  signed_at: string | null;
  signature_email_to: string | null;
  signature_token_expires_at: string | null;
  source_warehouse_id: string;
  destination_charter_id: string;
}

interface WarehouseRow {
  id: string;
  name: string;
}

interface CharterRow {
  id: string;
  name: string;
  code: string | null;
}

interface LineRow {
  id: string;
  qty_shipped: number | string;
  item:
    | { name: string; sku: string }
    | { name: string; sku: string }[]
    | null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Token validation — same shape as the page below. Skip the DB hit
  // when the token can't possibly match.
  const looksValid =
    typeof token === 'string' &&
    token.length >= 32 &&
    /^[a-f0-9]+$/i.test(token);
  if (!looksValid) {
    return { title: 'Sign packing slip', robots: { index: false, follow: false } };
  }
  const row = await lookupShipmentByToken(token);
  const wo = (row as { work_order_number?: string } | null)?.work_order_number;
  return {
    title: wo ? `Sign packing slip ${wo}` : 'Sign packing slip',
    robots: { index: false, follow: false },
  };
}

export default async function ShipmentSignaturePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Minimum sane token length — randomBytes(24).toString('hex') is 48 chars.
  // We accept slightly less to be friendly to copy-paste truncation, but the
  // schema in the action enforces /^[a-f0-9]+$/ and 32..96.
  const tokenLooksValid =
    typeof token === 'string' &&
    token.length >= 32 &&
    /^[a-f0-9]+$/i.test(token);

  if (!tokenLooksValid) {
    return (
      <PageShell>
        <InactiveCard
          title="Link not recognized"
          body="This signature link doesn't look right. Double-check the URL or scan the QR code on your packing slip again."
        />
      </PageShell>
    );
  }

  const admin = createAdminClient();

  // Pull the shipment + the two warehouse names + the org branding all up
  // front. One round trip would be nicer but the four lookups are cheap
  // and reading them separately keeps the typing honest.
  // M3: shared cached lookup with generateMetadata (above).
  const shipmentRow = await lookupShipmentByToken(token);

  if (!shipmentRow) {
    return (
      <PageShell>
        <InactiveCard
          title="This link is no longer active"
          body="The shipment may have been cancelled, or the link may have been retyped. Contact the warehouse manager listed on your packing slip if you need help."
        />
      </PageShell>
    );
  }
  const shipment = shipmentRow as unknown as ShipmentRow;

  // Expiry check (server-side enforcement; the schema permits any hex).
  const expired =
    shipment.signature_token_expires_at &&
    new Date(shipment.signature_token_expires_at).getTime() < Date.now();
  if (shipment.status === 'cancelled' || expired) {
    return (
      <PageShell>
        <InactiveCard
          title="This link is no longer active"
          body={
            shipment.status === 'cancelled'
              ? 'This shipment has been cancelled.'
              : 'This signature link has expired. Reach out to the warehouse manager to get a fresh link.'
          }
        />
      </PageShell>
    );
  }

  // Fetch related rows in parallel.
  const [srcRes, dstRes, linesRes, orgRes] = await Promise.all([
    admin
      .from('warehouses')
      .select('id, name')
      .eq('id', shipment.source_warehouse_id)
      .maybeSingle(),
    admin
      .from('charters')
      .select('id, name, code')
      .eq('id', shipment.destination_charter_id)
      .maybeSingle(),
    admin
      .from('shipment_lines')
      .select(
        'id, qty_shipped, line_order, item:inventory_items!item_id (name, sku)',
      )
      .eq('shipment_id', shipment.id)
      .order('line_order', { ascending: true }),
    admin
      .from('organizations')
      .select('name, logo_url')
      .eq('id', shipment.organization_id)
      .maybeSingle(),
  ]);
  const source = srcRes.data as WarehouseRow | null;
  const destination = dstRes.data as CharterRow | null;
  const lines = (linesRes.data ?? []) as LineRow[];
  const org =
    (orgRes.data as { name: string | null; logo_url: string | null } | null) ??
    null;
  const totalItems = lines.reduce(
    (s, l) => s + (Number(l.qty_shipped) || 0),
    0,
  );

  // Already-signed state — show a receipt, not the form.
  if (shipment.status === 'delivered') {
    const when = shipment.signed_at
      ? SIGNED_DATE_FMT.format(new Date(shipment.signed_at))
      : null;
    return (
      <PageShell org={org}>
        <SummaryBlock
          workOrderNumber={shipment.work_order_number}
          sourceName={source?.name ?? '—'}
          destinationName={destination?.name ?? '—'}
          totalItems={totalItems}
        />
        <div className="border-border bg-card mt-6 rounded-2xl border p-6 text-center">
          <h2 className="font-display text-lg">Already signed</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {shipment.signed_by_name ? (
              <>
                Signed by{' '}
                <span className="text-foreground font-medium">
                  {shipment.signed_by_name}
                </span>
                {when ? <> on {when}</> : null}.
              </>
            ) : (
              <>This shipment was already marked as delivered.</>
            )}
          </p>
          {shipment.signature_email_to ? (
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              A signed copy was emailed to{' '}
              <span className="text-foreground font-medium">
                {shipment.signature_email_to}
              </span>
              .
            </p>
          ) : null}
        </div>
      </PageShell>
    );
  }

  // Active — render the form.
  return (
    <PageShell org={org}>
      <SummaryBlock
        workOrderNumber={shipment.work_order_number}
        sourceName={source?.name ?? '—'}
        destinationName={destination?.name ?? '—'}
        totalItems={totalItems}
      />
      <LinePreview lines={lines} />
      <div className="mt-6">
        <PublicSignaturePage
          token={token}
          workOrderNumber={shipment.work_order_number}
          defaultEmail={shipment.signature_email_to ?? null}
        />
      </div>
    </PageShell>
  );
}

// ─── Server-component-only UI bits below (inlined for locality) ───────────

function PageShell({
  org,
  children,
}: {
  org?: { name: string | null; logo_url: string | null } | null;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-background min-h-svh">
      <div className="mx-auto max-w-lg px-4 py-8 sm:py-12">
        <header className="mb-6 flex flex-col items-center text-center">
          {org?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={org.logo_url}
              alt=""
              className="mb-3 h-10 w-10 rounded-lg object-cover"
            />
          ) : null}
          <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.12em]">
            Sign for delivery
          </p>
          <h1 className="font-display mt-1 text-[24px] font-medium leading-tight tracking-[-0.02em]">
            {org?.name ?? 'StockPilot'}
          </h1>
        </header>
        {children}
      </div>
    </div>
  );
}

function SummaryBlock({
  workOrderNumber,
  sourceName,
  destinationName,
  totalItems,
}: {
  workOrderNumber: string;
  sourceName: string;
  destinationName: string;
  totalItems: number;
}) {
  return (
    <div className="border-border bg-card rounded-2xl border p-5">
      <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.14em]">
        Shipment
      </p>
      <p className="mt-1 font-mono text-sm">{workOrderNumber}</p>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">From</dt>
          <dd className="text-foreground text-right font-medium">
            {sourceName}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">To</dt>
          <dd className="text-foreground text-right font-medium">
            {destinationName}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Items</dt>
          <dd className="text-foreground text-right font-medium tabular-nums">
            {totalItems}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function LinePreview({ lines }: { lines: LineRow[] }) {
  if (lines.length === 0) return null;
  const preview = lines.slice(0, 5);
  const remaining = lines.length - preview.length;
  return (
    <details className="border-border bg-card mt-3 overflow-hidden rounded-2xl border">
      <summary className="cursor-pointer list-none px-5 py-4 text-sm">
        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.14em]">
          What you&apos;re signing for
        </span>
        <span className="text-foreground ml-2 text-xs">
          ({lines.length} line{lines.length === 1 ? '' : 's'})
        </span>
      </summary>
      <div className="border-border border-t">
        <ul className="divide-border divide-y text-sm">
          {preview.map((l) => {
            const item = Array.isArray(l.item) ? l.item[0] ?? null : l.item;
            return (
              <li
                key={l.id}
                className="flex items-center justify-between gap-4 px-5 py-2.5"
              >
                <span className="text-foreground truncate">
                  {item?.name ?? 'Item'}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  ×{Number(l.qty_shipped) || 0}
                </span>
              </li>
            );
          })}
        </ul>
        {remaining > 0 ? (
          <p className="text-muted-foreground border-border border-t px-5 py-2.5 text-xs">
            and {remaining} more line{remaining === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function InactiveCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-border bg-card mt-4 rounded-2xl border p-6 text-center">
      <h2 className="font-display text-lg">{title}</h2>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        {body}
      </p>
    </div>
  );
}
