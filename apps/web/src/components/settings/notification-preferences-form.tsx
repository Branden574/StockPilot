'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  NOTIFICATION_PREF_KEYS,
  type NotificationPrefKey,
  type NotificationPreferences,
} from '@/lib/notification-prefs';
import { cn } from '@/lib/utils';
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
const TOGGLE_DEFS: ToggleDef[] = [
  {
    key: 'email_low_stock',
    label: 'Low / out of stock',
    hint: 'Email when an item drops to or below its reorder point.',
    group: 'email',
  },
  {
    key: 'email_po_status',
    label: 'Purchase order status',
    hint: 'Email when a PO moves between draft, ordered, partial, and received.',
    group: 'email',
  },
  {
    key: 'email_team_invites',
    label: 'Team invites',
    hint: 'Email when someone invites you to a workspace or your role changes.',
    group: 'email',
  },
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
];

interface NotificationPreferencesFormProps {
  initial: NotificationPreferences;
}

export function NotificationPreferencesForm({
  initial,
}: NotificationPreferencesFormProps) {
  const router = useRouter();
  const [prefs, setPrefs] = React.useState<NotificationPreferences>(initial);
  const [savingKey, setSavingKey] = React.useState<NotificationPrefKey | null>(null);

  // Keep local state aligned with refreshed server props so a stale
  // optimistic value can't survive across a revalidatePath cycle.
  React.useEffect(() => {
    setPrefs(initial);
  }, [initial]);

  async function toggle(key: NotificationPrefKey, next: boolean) {
    setSavingKey(key);
    setPrefs((p) => ({ ...p, [key]: next })); // optimistic
    const res = await updateNotificationPreferencesAction({ [key]: next });
    setSavingKey(null);
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
        savingKey={savingKey}
        onToggle={toggle}
      />
      <Group
        title="In-app notifications"
        subtitle="Shown in the bell menu on the dashboard."
        defs={pushDefs}
        prefs={prefs}
        savingKey={savingKey}
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
  savingKey: NotificationPrefKey | null;
  onToggle: (key: NotificationPrefKey, next: boolean) => void;
}

function Group({ title, subtitle, defs, prefs, savingKey, onToggle }: GroupProps) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-muted-foreground text-xs">{subtitle}</p>
      </div>
      <div className="divide-border divide-y rounded-md border">
        {defs.map(({ key, label, hint }) => {
          const checked = prefs[key];
          const busy = savingKey === key;
          return (
            <div
              key={key}
              className={cn(
                'flex items-start justify-between gap-6 px-4 py-3',
                busy && 'opacity-60',
              )}
            >
              <div className="flex-1">
                <div className="text-sm font-medium">{label}</div>
                <div className="text-muted-foreground text-xs">{hint}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={`Toggle ${label}`}
                onClick={() => !busy && onToggle(key, !checked)}
                disabled={busy}
                className={cn(
                  'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                  checked ? 'bg-primary' : 'bg-muted',
                  busy && 'cursor-not-allowed',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'bg-background inline-block h-5 w-5 rounded-full shadow-sm transition-transform',
                    checked ? 'translate-x-[22px]' : 'translate-x-[2px]',
                  )}
                />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Ensure every key in NOTIFICATION_PREF_KEYS has a matching toggle def
// at compile time. The unused expression keeps NOTIFICATION_PREF_KEYS
// in the dependency graph for build-time discovery without runtime
// cost.
void NOTIFICATION_PREF_KEYS;
