import {
  describeHoldResult,
  NEEDED_BY_REVISED_TIMELINE_LABEL,
  neededByLabel,
  parseHoldOrderStockResult,
  resolveOrgTimezone,
  SHORTFALL_PO_TIMELINE_LABEL,
  shortfallPoTimelineDetail,
  type HoldOrderStockResult,
} from '@stockpilot/core';

import { LocalDateTime } from '@/components/ui/local-datetime';
import { isPlatformAdmin } from '@/lib/auth/platform-admin';
import { createClient } from '@/lib/supabase/server';

interface Props {
  orderId: string;
  organizationId: string;
  /** The org's zone (the order page's), for the dates a needed-by change
   *  names. Core's default when absent. */
  timeZone?: string;
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
  'order.delivery_request_drafted': 'Delivery request drafted',
  // F2-2: hold_order_stock held stock for the order. The label depends on
  // what started it (eventLabel below); this is the manual "Hold available
  // stock", and the fallback for an entry without a trigger.
  'order.stock_held': 'Stock held',
  // F2-4 (0383): an approver changed the needed-by date, with a reason (core's
  // label; the detail line names both dates in the org's zone, and the reason
  // follows as every entry's does).
  'order_request.needed_by_revised': NEEDED_BY_REVISED_TIMELINE_LABEL,
  // F2-5 (0385): draft POs were created for what the order was short (core's
  // label; the detail line says which drafts, for how many items and units).
  'order_request.shortfall_po_drafted': SHORTFALL_PO_TIMELINE_LABEL,
};

/**
 * order.stock_held says what started the hold (after.trigger, written by
 * OrderRequestsService.holdStock): an approver adding items to the order or
 * raising a line; "Hold available stock" is the manual one. The label names
 * the trigger only, never a scope: the top-up holds everything on the order
 * not yet held (a requester's earlier line too), and the detail line says how
 * much.
 */
const STOCK_HELD_LABELS: Readonly<Record<string, string>> = {
  lines_added: 'Stock held after items were added',
  line_raised: 'Stock held after a quantity was raised',
  manual: 'Stock held',
};

function eventLabel(event: string, metadata: Record<string, unknown> | null): string {
  if (event === 'order.stock_held') {
    const after = (metadata?.after ?? {}) as Record<string, unknown>;
    const trigger = typeof after.trigger === 'string' ? after.trigger : '';
    return STOCK_HELD_LABELS[trigger] ?? EVENT_LABELS[event]!;
  }
  return (
    EVENT_LABELS[event] ??
    prettyStatus(event.split('.').pop() ?? event).replace(/^\w/, (c) => c.toUpperCase())
  );
}

const prettyStatus = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/_/g, ' ') : String(v);

/**
 * Human-readable detail lines (owner request 2026-07-12): regular members
 * must never see raw audit JSON — that belongs in the platform console.
 * Each line states either what the event MEANS for the order or a concrete
 * fact pulled from a known metadata key. Unknown keys are simply not
 * surfaced here (the platform-admin raw block below still has everything).
 */
function humanDetails(
  event: string,
  metadata: Record<string, unknown> | null,
  actor: string,
  timeZone: string,
): string[] {
  const md = metadata ?? {};
  const after = (md.after ?? {}) as Record<string, unknown>;
  const before = (md.before ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  switch (event) {
    case 'order_request.created': {
      const n = after.lineCount ?? md.lineCount;
      if (typeof n === 'number') lines.push(`${n} line${n === 1 ? '' : 's'} requested.`);
      lines.push('Waiting for a manager to review and approve.');
      break;
    }
    case 'order_request.approved':
      lines.push('Stock reserved — the order entered the fulfillment pipeline.');
      break;
    case 'order_request.denied':
      lines.push('The request was declined; nothing was reserved.');
      break;
    case 'order_request.cancelled':
      lines.push('Reserved stock was released back to availability.');
      break;
    case 'order_request.status_changed':
      if (before.status || after.status) {
        lines.push(`${prettyStatus(before.status)} → ${prettyStatus(after.status)}.`);
      }
      break;
    case 'order_request.public_link_rotated':
      lines.push('The previous public order link stopped working and a new one was issued.');
      break;
    case 'order.pick_slip_generated':
      lines.push('Pick slip ready — items can now be gathered from their locations.');
      break;
    case 'order.picking_claimed':
      lines.push(`Locked to ${actor} — no one else can pick this order until it is released.`);
      break;
    case 'order.picker_assigned':
      lines.push('A picker was assigned to work this order.');
      break;
    case 'order.picking_released':
      lines.push('The picking lock was released — any teammate can claim it now.');
      break;
    case 'order.picking_complete':
      lines.push('Picked quantities recorded; the order can move to packing.');
      break;
    case 'order.packing_slip_generated':
      lines.push('Packing slips ready — items get boxed and labeled next.');
      break;
    case 'order.staged_for_pickup':
      lines.push('Packed and waiting at the staging area for pickup.');
      break;
    case 'order.staged_for_delivery':
      lines.push('Packed and waiting at the staging area for a delivery run.');
      break;
    case 'order.delivery_assigned':
      lines.push('A delivery driver was assigned.');
      break;
    case 'order.in_transit':
      lines.push('Out for delivery.');
      break;
    case 'order.signature_collected':
      lines.push('Signature captured at hand-over.');
      break;
    case 'order.completed':
      lines.push('Hand-over finished — fulfilled quantities are final.');
      break;
    case 'order.delivery_request_drafted':
      lines.push('A prefilled draft was opened — StockPilot did not send it.');
      break;
    case 'order.stock_held': {
      // What was held and what is still short, in core's words (the same
      // sentence "Hold available stock" says). Holds move no stock. Items the
      // holder could not see are counted, never numbered. An entry this page
      // cannot read is described without numbers, never guessed.
      let held: HoldOrderStockResult | null = null;
      try {
        held = parseHoldOrderStockResult({
          held: after.held,
          stillShort: after.stillShort,
          hiddenHeldItems: after.hiddenHeldItems,
          hiddenShortItems: after.hiddenShortItems,
        });
      } catch {
        held = null;
      }
      lines.push(held ? describeHoldResult(held) : 'Stock was held for this order.');
      break;
    }
    case 'order_request.needed_by_revised': {
      // metadata.from / .to: ISO instants (from is null when the order had
      // none), written by OrderRequestsService.reviseNeededBy. Printed in the
      // org's zone as the order page prints the date; an entry this page
      // cannot read says nothing rather than guess.
      const when = (v: unknown): string | null =>
        typeof v === 'string' && Number.isFinite(Date.parse(v)) ? neededByLabel(v, timeZone) : null;
      const to = when(md.to);
      const from = when(md.from);
      if (to) lines.push(from ? `${from} → ${to}` : `Set to ${to}`);
      break;
    }
    case 'order_request.shortfall_po_drafted': {
      // The drafts, how many items and units, and that drafts are not sent:
      // core's sentence (shortfallPoTimelineDetail, from metadata.po_numbers
      // and .lines, never a cost). An entry it cannot read says nothing.
      const detail = shortfallPoTimelineDetail(md);
      if (detail) lines.push(detail);
      break;
    }
    default:
      break;
  }

  // Facts that read well regardless of event type.
  if (typeof md.reason === 'string' && md.reason.trim()) {
    lines.push(`Reason: ${md.reason.trim()}`);
  }
  if (typeof md.note === 'string' && md.note.trim()) {
    lines.push(`Note: ${md.note.trim()}`);
  }
  return lines;
}

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
 * Regular members see human-readable detail lines only. The raw metadata
 * payload renders EXCLUSIVELY for platform admins (deploy-time allowlist,
 * same gate as the /platform console) — internal ids and event plumbing
 * are not for org members, super-admin or otherwise.
 */
export async function OrderTimeline({ orderId, organizationId, timeZone }: Props) {
  const zone = resolveOrgTimezone(timeZone);
  const supabase = await createClient();
  const [{ data }, { data: auth }] = await Promise.all([
    supabase
      .from('audit_logs')
      .select('id, event, created_at, user_id, metadata')
      .eq('organization_id', organizationId)
      .or(`event.like.order_request.%,event.like.order.%`)
      .filter('metadata->>entity_id', 'eq', orderId)
      .order('created_at', { ascending: true }),
    supabase.auth.getUser(),
  ]);
  const showRaw = isPlatformAdmin(auth.user?.email);

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
      // in-list-bound: the distinct people who acted on this one order (a handful)
      .in('id', userIds);
    for (const p of (profiles ?? []) as UserProfile[]) {
      usersById.set(p.id, p);
    }
  }

  return (
    <ol className="border-border space-y-3 border-l-2 pl-4">
      {rows.map((row) => {
        const label = eventLabel(row.event, row.metadata);
        const profile = row.user_id ? usersById.get(row.user_id) ?? null : null;
        const actor =
          profile?.full_name ?? profile?.email ?? (row.user_id ? 'Unknown user' : 'Public');
        const details = humanDetails(row.event, row.metadata, actor, zone);
        return (
          <li key={row.id} className="relative">
            <span className="bg-primary absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full" />
            <div className="text-sm">
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground"> — {actor}</span>
            </div>
            {/* This is a SERVER component, so toLocaleString() ran in the
                deployment's timezone (UTC on Vercel) and there was no
                hydration pass to correct it — every entry showed a wall-clock
                time hours off from the viewer's, permanently. LocalDateTime is
                a client component that fills the text in after mount. */}
            <div className="text-muted-foreground text-xs">
              <LocalDateTime iso={row.created_at} />
            </div>
            {details.length > 0 && (
              <div className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                {details.map((d, i) => (
                  <p key={i}>{d}</p>
                ))}
              </div>
            )}
            {showRaw && row.metadata && (
              <details className="text-muted-foreground mt-1 text-xs">
                <summary className="cursor-pointer opacity-70">
                  Raw event · platform admin
                </summary>
                <pre className="mt-1 whitespace-pre-wrap text-[11px]">
                  {JSON.stringify(row.metadata, null, 2)}
                </pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
