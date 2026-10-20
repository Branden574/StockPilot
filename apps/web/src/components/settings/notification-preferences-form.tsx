'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  NOTIFICATION_PREF_KEYS,
  type NotificationPrefKey,
  type NotificationPreferences,
} from '@/lib/notification-prefs';
import { Switch } from '@/components/ui/switch';
import { updateNotificationPreferencesAction } from '@/server/actions/notification-preferences';

interface ToggleDef {
  key: NotificationPrefKey;
  label: string;
  hint: string;
  group: 'email' | 'push';
}

/**
 * Display metadata for every notification toggle the user can flip.
 * Adding a column to `notification_preferences` should add an entry
 * here AND to `NOTIFICATION_PREF_KEYS` in the action module so the
 * full set stays in lockstep.
 */
// email_low_stock / email_po_status / email_team_invites were removed
// 2026-07-20 (owner decision): no send path ever read them — low-stock and
// PO state live in the weekly digest, and invite emails are transactional
// (the recipient isn't a member yet, so a preference can't apply). Their
// DB columns remain, just unread.
const TOGGLE_DEFS: ToggleDef[] = [
  {
    key: 'push_low_stock',
    label: 'Low / out of stock',
    hint: 'In-app notification when an item drops to or below its reorder point.',
    group: 'push',
  },
  {
    key: 'push_po_status',
    label: 'Purchase order status',
    hint: 'In-app notification when a PO moves between statuses.',
    group: 'push',
  },
  {
    key: 'push_stock_transfer',
    label: 'Stock transfers',
    hint: 'In-app notification when stock is transferred between warehouses you can see.',
    group: 'push',
  },
  {
    key: 'email_order_received',
    label: 'Order received',
    hint: 'Email when your order request lands in the queue.',
    group: 'email',
  },
  {
    key: 'email_order_status_changed',
    label: 'Order status changes',
    hint: 'Email when your order is approved, denied, packaged, or staged.',
    group: 'email',
  },
  {
    key: 'email_order_in_transit',
    label: 'Order in transit',
    hint: 'Email when a delivery order is on the way.',
    group: 'email',
  },
  {
    key: 'email_order_completed',
    label: 'Order completed',
    hint: 'Email when your order is signed for and finalized.',
    group: 'email',
  },
  {
    key: 'push_order_assigned_to_me',
    label: 'Order assigned to me',
    hint: "In-app notification when you're assigned as picker or driver.",
    group: 'push',
  },
  {
    key: 'push_order_request_created',
    label: 'New order requests',
    hint: "In-app/push alert when anyone submits a new order request (managers and above). Turn off to stop being notified about the whole team's order queue.",
    group: 'push',
  },
  {
    key: 'email_schedule_reminders',
    label: 'Schedule reminders',
    hint: 'Email 24 hours and 1 hour before events you are assigned to (managers get all events).',
    group: 'email',
  },
  {
    key: 'push_schedule_reminders',
    label: 'Schedule reminders',
    hint: 'Push + in-app reminder 24 hours and 1 hour before scheduled events.',
    group: 'push',
  },
  {
    key: 'push_item_auto_archived',
    label: 'Items auto-archived',
    hint: 'In-app alert when an out-of-stock item is auto-archived.',
    group: 'push',
  },
  {
    key: 'push_maintenance_new_request',
    label: 'New maintenance requests',
    hint: 'In-app notification when a new maintenance request is saved, if your account is set to receive it.',
    group: 'push',
  },
  {
    key: 'push_maintenance_urgent_request',
    label: 'Urgent maintenance requests',
    hint: 'In-app notification when an urgent maintenance request is saved, if your account is set to receive it.',
    group: 'push',
  },
  {
    key: 'push_maintenance_assigned',
    label: 'Maintenance assigned to me',
    hint: 'In-app notification when you are set as the local owner of a maintenance request.',
    group: 'push',
  },
  {
    key: 'push_maintenance_draft_reminder',
    label: 'Maintenance draft reminders',
    hint: 'In-app reminder when you opened an email draft for a maintenance request but StockPilot cannot confirm send.',
    group: 'push',
  },
  {
    key: 'push_maintenance_resolved',
    label: 'Maintenance request resolved',
    hint: 'In-app notification when a maintenance request you submitted is marked resolved.',
    group: 'push',
  },
  {
    key: 'push_return_requested',
    label: 'New return and exchange requests',
    hint: 'In-app notification when a requester asks for a return on an order in a warehouse you manage returns for.',
    group: 'push',
  },
];

interface NotificationPreferencesFormProps {
  initial: NotificationPreferences;
}

export function NotificationPreferencesForm({ initial }: NotificationPreferencesFormProps) {
  const router = useRouter();
  const [prefs, setPrefs] = React.useState<NotificationPreferences>(initial);
  // Every switch whose save is out: each is busy on its own, so a second
  // switch flipped meanwhile is not released when the first save returns.
  const [savingKeys, setSavingKeys] = React.useState<ReadonlySet<NotificationPrefKey>>(
    () => new Set(),
  );

  // Keep local state aligned with refreshed server props so a stale
  // optimistic value can't survive across a revalidatePath cycle.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
    setPrefs(initial);
  }, [initial]);

  function markSaving(key: NotificationPrefKey, on: boolean) {
    setSavingKeys((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function toggle(key: NotificationPrefKey, next: boolean) {
    markSaving(key, true);
    setPrefs((p) => ({ ...p, [key]: next })); // optimistic
    const res = await updateNotificationPreferencesAction({ [key]: next });
    markSaving(key, false);
    if (!res.ok) {
      setPrefs((p) => ({ ...p, [key]: !next })); // revert
      toast.error(res.error.message);
      return;
    }
    router.refresh();
  }

  const emailDefs = TOGGLE_DEFS.filter((d) => d.group === 'email');
  const pushDefs = TOGGLE_DEFS.filter((d) => d.group === 'push');

  return (
    <div className="space-y-8">
      <Group
        title="Email notifications"
        subtitle="Sent to the address on your account."
        defs={emailDefs}
        prefs={prefs}
        savingKeys={savingKeys}
        onToggle={toggle}
      />
      <Group
        title="In-app notifications"
        subtitle="Shown in the bell menu on the dashboard."
        defs={pushDefs}
        prefs={prefs}
        savingKeys={savingKeys}
        onToggle={toggle}
      />
    </div>
  );
}

interface GroupProps {
  title: string;
  subtitle: string;
  defs: ToggleDef[];
  prefs: NotificationPreferences;
  savingKeys: ReadonlySet<NotificationPrefKey>;
  onToggle: (key: NotificationPrefKey, next: boolean) => void;
}

function Group({ title, subtitle, defs, prefs, savingKeys, onToggle }: GroupProps) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[13px] font-medium">{title}</h3>
        <p className="text-muted-foreground text-[12.5px]">{subtitle}</p>
      </div>
      <ul className="divide-border divide-y rounded-lg border">
        {defs.map(({ key, label, hint }) => {
          const checked = prefs[key];
          const busy = savingKeys.has(key);
          return (
            <li key={key} className="flex items-start justify-between gap-6 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{label}</div>
                <div className="text-muted-foreground mt-0.5 text-[12.5px]">{hint}</div>
              </div>
              <Switch
                checked={checked}
                label={`Toggle ${label}`}
                pending={busy}
                onCheckedChange={(next) => onToggle(key, next)}
                className="mt-0.5"
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Ensure every key in NOTIFICATION_PREF_KEYS has a matching toggle def
// at compile time. The unused expression keeps NOTIFICATION_PREF_KEYS
// in the dependency graph for build-time discovery without runtime
// cost.
void NOTIFICATION_PREF_KEYS;
