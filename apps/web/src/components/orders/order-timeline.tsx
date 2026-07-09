import { createClient } from '@/lib/supabase/server';

interface Props {
  orderId: string;
  organizationId: string;
}

interface AuditRow {
  id: string;
  event: string;
  created_at: string;
  user_id: string | null;
  metadata: Record<string, unknown> | null;
}

interface UserProfile {
  id: string;
  full_name: string | null;
  email: string | null;
}

const EVENT_LABELS: Record<string, string> = {
  'order_request.created': 'Order submitted',
  'order_request.approved': 'Approved',
  'order_request.denied': 'Denied',
  'order_request.status_changed': 'Status changed',
  'order_request.cancelled': 'Cancelled',
  'order_request.delivered': 'Delivered (legacy)',
  'order_request.public_link_rotated': 'Public link rotated',
  'order.pick_slip_generated': 'Pick slip generated',
  'order.picking_claimed': 'Picking claimed',
  'order.picker_assigned': 'Picker assigned',
  'order.picking_released': 'Picking released',
  'order.picking_complete': 'Picking complete',
  'order.packing_slip_generated': 'Packing slips generated',
  'order.staged_for_pickup': 'Staged for pickup',
  'order.staged_for_delivery': 'Staged for delivery',
  'order.delivery_assigned': 'Delivery assigned',
  'order.in_transit': 'In transit',
  'order.signature_collected': 'Signature collected',
  'order.completed': 'Completed',
};

/**
 * Server-rendered audit-log driven timeline for a single order request.
 *
 * Filters on `entity_id` inside `audit_logs.metadata` (jsonb) rather than
 * a row-level column — `audit_logs` only stores `event`, `metadata`, `ip`,
 * `user_agent`, `user_id`, `organization_id`, `created_at`. Both the legacy
 * `order_request.*` events (phase 1-2) and new `order.*` events (phase 3-5)
 * use `entityType: 'order_request'` + `entityId: <request.id>` so a single
 * `metadata->>entity_id` filter captures the full history.
 *
 * The user is fetched in a second query (no FK embed) to mirror the pattern
 * the admin audit page uses; PostgREST hint syntax for embedded selects can
 * be brittle when the FK target is `user_profiles` rather than `auth.users`.
 */
export async function OrderTimeline({ orderId, organizationId }: Props) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('audit_logs')
    .select('id, event, created_at, user_id, metadata')
    .eq('organization_id', organizationId)
    .or(`event.like.order_request.%,event.like.order.%`)
    .filter('metadata->>entity_id', 'eq', orderId)
    .order('created_at', { ascending: true });

  const rows = (data ?? []) as AuditRow[];

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">No events yet.</div>
    );
  }

  const userIds = [
    ...new Set(rows.map((r) => r.user_id).filter((v): v is string => Boolean(v))),
  ];
  const usersById = new Map<string, UserProfile>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, full_name, email')
      .in('id', userIds);
    for (const p of (profiles ?? []) as UserProfile[]) {
      usersById.set(p.id, p);
    }
  }

  return (
    <ol className="border-border space-y-3 border-l-2 pl-4">
      {rows.map((row) => {
        const label = EVENT_LABELS[row.event] ?? row.event;
        const profile = row.user_id ? usersById.get(row.user_id) ?? null : null;
        const actor =
          profile?.full_name ?? profile?.email ?? (row.user_id ? 'Unknown user' : 'Public');
        // metadata always wraps the audit payload; the user-visible "extras"
        // are everything except the wrapper keys we know are null on most
        // events. Stripping them keeps the <details> payload focused.
        const extras = row.metadata
          ? Object.fromEntries(
              Object.entries(row.metadata).filter(
                ([k, v]) =>
                  !['entity_type', 'entity_id', 'warehouse_id', 'before', 'after', 'reason'].includes(
                    k,
                  ) || v !== null,
              ),
            )
          : {};
        const hasExtras = Object.keys(extras).length > 0;
        return (
          <li key={row.id} className="relative">
            <span className="bg-primary absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full" />
            <div className="text-sm">
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground"> — {actor}</span>
            </div>
            <div className="text-muted-foreground text-xs" suppressHydrationWarning>
              {new Date(row.created_at).toLocaleString()}
            </div>
            {hasExtras ? (
              <details className="text-muted-foreground mt-1 text-xs">
                <summary className="cursor-pointer">Details</summary>
                <pre className="mt-1 whitespace-pre-wrap text-[11px]">
                  {JSON.stringify(extras, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
