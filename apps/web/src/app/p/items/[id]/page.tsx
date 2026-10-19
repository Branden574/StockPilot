import { Sparkles } from 'lucide-react';
import Image from 'next/image';
import { notFound } from 'next/navigation';

import { ExternalEyebrow, ExternalShell } from '@/components/auth/external-shell';
import { KeyValueList, KeyValueRow } from '@/components/patterns/key-value-row';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getPublicItem } from '@/server/services/public-items';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, unauthenticated item view. Reachable from any QR code our
 * label printer generated — anyone with a phone camera can scan and
 * land here, no account required.
 *
 * The shaping function in server/services/public-items.ts is the
 * security boundary. It strips quantities, costs, supplier info,
 * locations, internal notes, and audit metadata before they ever
 * reach this component. Don't pull additional fields here without
 * adding tests in public-items.test.ts.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = await getPublicItem(id);
  // F8: noindex the public item page. The page is intentionally public
  // (anyone with a QR scan can land here) but should NOT be a crawled,
  // search-indexable surface — quantity-on-hand and cover images
  // leaking into Google's index would broaden the threat model beyond
  // the labeled-item-in-the-building case we accept. Matches /r, /s,
  // /invite.
  // Titles get " · StockPilot" from the root layout's template (CONFLICTS D15).
  if (!item) {
    return {
      title: 'Item not found',
      robots: { index: false, follow: false },
    };
  }
  const subtitle = item.bookAuthor ?? item.category ?? 'Inventory item';
  return {
    title: item.name,
    description: subtitle,
    robots: { index: false, follow: false },
    openGraph: {
      title: item.name,
      description: subtitle,
      images: item.imageUrl ? [item.imageUrl] : undefined,
    },
  };
}

export default async function PublicItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = await getPublicItem(id);
  if (!item) notFound();

  const typeLabel: Record<typeof item.itemType, string> = {
    product: 'Product',
    book: 'Book',
    asset: 'Asset',
    consumable: 'Consumable',
  };

  const book =
    item.itemType === 'book' &&
    (item.bookAuthor || item.bookPublisher || item.bookPublishedDate || item.bookGrade);

  return (
    <ExternalShell width="md">
      {/* Header */}
      <ExternalEyebrow className="mb-6 flex items-center gap-2">
        <Sparkles className="h-3 w-3" aria-hidden />
        StockPilot · Item details
      </ExternalEyebrow>

      {/* Image — LCP element on this page; priority + AVIF/WebP via */}
      {/* next/image. width/height are required, but the actual layout */}
      {/* is fluid via the `h-auto w-full` className so they only act as */}
      {/* an aspect-ratio hint to reserve space and avoid CLS. The frame is */}
      {/* white in both themes, like every product photo in the app. */}
      {item.imageUrl ? (
        <div className="border-border mb-6 overflow-hidden rounded-lg border bg-white">
          <Image
            src={item.imageUrl}
            alt={item.name}
            width={800}
            height={800}
            priority
            sizes="(max-width: 640px) 100vw, 600px"
            className="h-auto w-full object-cover"
          />
        </div>
      ) : null}

      {/* Title + type */}
      <h1 className="font-display text-foreground text-[26px] font-medium leading-[1.2] tracking-[-0.025em] [overflow-wrap:anywhere]">
        {item.name}
      </h1>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{typeLabel[item.itemType]}</Badge>
        {item.category ? <Badge variant="outline">{item.category}</Badge> : null}
      </div>

      {/* On-hand quantity — the main reason a warehouse staffer
          scans a label. The word says the state (Out of stock / Last one /
          In stock) and the wash colours it: red = 0, amber = 1, green = in
          stock. Each tone pairs its own ink with its own wash, which reads in
          both themes (the amber pair was 1.06:1 in dark). */}
      <div
        data-slot="public-on-hand"
        data-stock={item.quantityOnHand <= 0 ? 'out' : item.quantityOnHand === 1 ? 'last' : 'in'}
        className={cn(
          'mt-5 flex items-baseline justify-between rounded-lg px-5 py-4',
          item.quantityOnHand <= 0
            ? 'bg-destructive-wash text-destructive'
            : item.quantityOnHand === 1
              ? 'bg-warning-wash text-warning'
              : 'bg-success-wash text-success',
        )}
      >
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.1em]">On hand</div>
          <div className="font-display mt-0.5 text-[32px] font-medium tabular-nums leading-none tracking-[-0.02em]">
            {item.quantityOnHand}
          </div>
        </div>
        <div className="text-[11px] font-medium uppercase tracking-[0.08em]">
          {item.quantityOnHand <= 0
            ? 'Out of stock'
            : item.quantityOnHand === 1
              ? 'Last one'
              : 'In stock'}
        </div>
      </div>

      {/* Book metadata */}
      {book ? (
        <div className="border-border bg-card mt-6 overflow-hidden rounded-lg border">
          <KeyValueList>
            {item.bookAuthor ? <KeyValueRow label="Author">{item.bookAuthor}</KeyValueRow> : null}
            {item.bookPublisher ? (
              <KeyValueRow label="Publisher">{item.bookPublisher}</KeyValueRow>
            ) : null}
            {item.bookPublishedDate ? (
              <KeyValueRow label="Published">{item.bookPublishedDate}</KeyValueRow>
            ) : null}
            {item.bookGrade ? <KeyValueRow label="Grade">{item.bookGrade}</KeyValueRow> : null}
          </KeyValueList>
        </div>
      ) : null}

      {/* Footer note */}
      <p className="text-muted-foreground mt-8 text-[12.5px] leading-relaxed">
        This is a public preview. Prices, suppliers, locations, and
        internal notes aren&apos;t shown. If you&apos;re part of the team,{' '}
        <a className="text-foreground underline underline-offset-2" href="/signin">
          sign in
        </a>{' '}
        to see full details and edit.
      </p>
    </ExternalShell>
  );
}
