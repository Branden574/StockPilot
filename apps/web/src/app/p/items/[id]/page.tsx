import { Sparkles } from 'lucide-react';
import { notFound } from 'next/navigation';

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
  if (!item) {
    return { title: 'Item not found · StockPilot' };
  }
  const subtitle = item.bookAuthor ?? item.category ?? 'Inventory item';
  return {
    title: `${item.name} · StockPilot`,
    description: subtitle,
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

        {/* Image */}
        {item.imageUrl ? (
          <div className="border-border bg-card mb-6 overflow-hidden rounded-2xl border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.imageUrl}
              alt=""
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
          This is a public preview. Quantities, prices, suppliers, and
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
