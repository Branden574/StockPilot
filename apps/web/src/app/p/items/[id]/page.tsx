import { Sparkles } from 'lucide-react';
import Image from 'next/image';
import { notFound } from 'next/navigation';

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
  if (!item) {
    return {
      title: 'Item not found · StockPilot',
      robots: { index: false, follow: false },
    };
  }
  const subtitle = item.bookAuthor ?? item.category ?? 'Inventory item';
  return {
    title: `${item.name} · StockPilot`,
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

  return (
    <div className="bg-background text-foreground min-h-screen px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-md">
        {/* Header */}
        <header className="mb-6 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
          <Sparkles className="h-3 w-3" />
          StockPilot · Item details
        </header>

        {/* Image — LCP element on this page; priority + AVIF/WebP via */}
        {/* next/image. width/height are required, but the actual layout */}
        {/* is fluid via the `h-auto w-full` className so they only act as */}
        {/* an aspect-ratio hint to reserve space and avoid CLS. */}
        {item.imageUrl ? (
          <div className="border-border bg-card mb-6 overflow-hidden rounded-2xl border">
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
        <h1 className="font-display text-[28px] font-medium leading-tight tracking-[-0.025em]">
          {item.name}
        </h1>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="border-border text-muted-foreground inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px]">
            {typeLabel[item.itemType]}
          </span>
          {item.category ? (
            <span className="border-border text-muted-foreground inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px]">
              {item.category}
            </span>
          ) : null}
        </div>

        {/* On-hand quantity — the main reason a warehouse staffer
            scans a label. Color-coded so "out of stock" reads at a
            glance: green = in stock, amber = 1, red = 0. */}
        <div
          className={cn(
            'mt-5 flex items-baseline justify-between rounded-2xl border px-5 py-4',
            item.quantityOnHand <= 0
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : item.quantityOnHand === 1
                ? 'border-warning/40 bg-warning/5 text-warning-foreground'
                : 'border-success/40 bg-success/5',
          )}
        >
          <div>
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] opacity-70">
              On hand
            </div>
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
        {item.itemType === 'book' && (item.bookAuthor || item.bookPublisher || item.bookPublishedDate || item.bookGrade) ? (
          <dl className="border-border mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-2xl border p-4 text-sm">
            {item.bookAuthor ? (
              <>
                <dt className="text-muted-foreground text-[11px] uppercase tracking-wider">
                  Author
                </dt>
                <dd>{item.bookAuthor}</dd>
              </>
            ) : null}
            {item.bookPublisher ? (
              <>
                <dt className="text-muted-foreground text-[11px] uppercase tracking-wider">
                  Publisher
                </dt>
                <dd>{item.bookPublisher}</dd>
              </>
            ) : null}
            {item.bookPublishedDate ? (
              <>
                <dt className="text-muted-foreground text-[11px] uppercase tracking-wider">
                  Published
                </dt>
                <dd>{item.bookPublishedDate}</dd>
              </>
            ) : null}
            {item.bookGrade ? (
              <>
                <dt className="text-muted-foreground text-[11px] uppercase tracking-wider">
                  Grade
                </dt>
                <dd>{item.bookGrade}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {/* Footer note */}
        <p className="text-muted-foreground mt-8 text-[12px] leading-relaxed">
          This is a public preview. Prices, suppliers, locations, and
          internal notes aren&apos;t shown. If you&apos;re part of the team,{' '}
          <a className="underline" href="/signin">
            sign in
          </a>{' '}
          to see full details and edit.
        </p>
      </div>
    </div>
  );
}
