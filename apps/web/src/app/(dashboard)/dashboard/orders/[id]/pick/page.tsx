import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { DigitalPick } from '@/components/orders/digital-pick';
import { OrderRequestsService } from '@/server/services/order-requests';

export const dynamic = 'force-dynamic';

export default async function DigitalPickPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = await OrderRequestsService.forCurrentUser();
  const detail = await svc.get(id).catch(() => null);
  if (!detail) notFound();

  if (
    detail.request.status !== 'pick_slip_generated' &&
    detail.request.status !== 'picking_in_progress'
  ) {
    redirect(`/dashboard/orders/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <Link
        href={`/dashboard/orders/${id}`}
        className="text-muted-foreground hover:text-foreground text-sm"
      >
        ← Back to order
      </Link>
      <header className="mt-3">
        <h1 className="font-display text-2xl">Pick slip</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Order #{id.slice(0, 8).toUpperCase()} ·{' '}
          {detail.request.requester_name ?? detail.request.requester_email ?? '—'}
        </p>
      </header>
      <div className="mt-6">
        <DigitalPick orderId={id} initialLines={detail.lines} />
      </div>
    </div>
  );
}
