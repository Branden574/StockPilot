import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { DigitalPick } from '@/components/orders/digital-pick';
import { requireOrgContext } from '@/lib/auth/session';
import { checkModuleAccess } from '@/lib/modules/module-gate';
import { createClient } from '@/lib/supabase/server';
import { isManagerOrAbove } from '@stockpilot/core';
import { LotsService } from '@/server/services/lots';
import type { FefoSuggestion } from '@/server/services/lots';
import { OrderRequestsService } from '@/server/services/order-requests';

export const dynamic = 'force-dynamic';

export default async function DigitalPickPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  const svc = await OrderRequestsService.forCurrentUser();
  const detail = await svc.get(id).catch(() => null);
  if (!detail) notFound();

  if (
    detail.request.status !== 'pick_slip_generated' &&
    detail.request.status !== 'picking_in_progress'
  ) {
    redirect(`/dashboard/orders/${id}`);
  }

  // Picking claim/lock: the server RPCs already reject a write from anyone but
  // the assigned picker or a manager+, but render a read-only notice here so a
  // non-picker doesn't stare at editable inputs that will just error. Mirrors
  // the shared state machine's picking-phase gate.
  const assignedPickerId = detail.request.assigned_picker_id;
  const canPick =
    isManagerOrAbove(ctx.role) ||
    (assignedPickerId !== null && assignedPickerId === ctx.userId);
  let assignedPickerName: string | null = null;
  if (!canPick && assignedPickerId) {
    const supabase = await createClient();
    const { data: pk } = await supabase
      .from('user_profiles')
      .select('full_name, email')
      .eq('id', assignedPickerId)
      .maybeSingle();
    assignedPickerName = pk
      ? (pk.full_name as string | null)?.trim() ||
        (pk.email as string | null) ||
        null
      : null;
  }

  // Phase 5: advisory FEFO picking hint. Only build the per-item suggestion
  // map when the lot_serial module is enabled — fail closed otherwise so the
  // existing pick/stock logic is completely untouched for non-food orgs.
  const { enabled: lotSerialEnabled } = await checkModuleAccess('lot_serial');
  let fefoByItemId: Record<string, FefoSuggestion[]> = {};
  if (lotSerialEnabled) {
    const lotItemIds = Array.from(
      new Set(
        detail.lines
          .filter((l) => l.item?.tracking_type === 'lot')
          .map((l) => l.item!.id),
      ),
    );
    if (lotItemIds.length > 0) {
      const lotsSvc = await LotsService.forCurrentUser();
      // ONE aging scan for all lot-tracked items (avoids the per-item N+1).
      fefoByItemId = await lotsSvc.getFefoSuggestionsByItems(lotItemIds);
    }
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
          {detail.requesterName ?? detail.requesterEmail ?? '—'}
        </p>
      </header>
      <div className="mt-6">
        <DigitalPick
          orderId={id}
          initialLines={detail.lines}
          canPick={canPick}
          assignedPickerName={assignedPickerName}
          lotSerial={lotSerialEnabled ? { enabled: true, fefoByItemId } : undefined}
        />
      </div>
    </div>
  );
}
