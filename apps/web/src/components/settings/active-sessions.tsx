'use client';

import { Check, Loader2, MonitorSmartphone, Pencil, ShieldCheck, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  renameSessionAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
} from '@/server/actions/sessions';
import type { SessionInfo } from '@/server/services/sessions';

function formatLastActive(iso: string | null): string {
  if (!iso) return 'unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

const MAX_NAME = 60;

export function ActiveSessions({ sessions }: { sessions: SessionInfo[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [savingId, setSavingId] = React.useState<string | null>(null);
  const others = sessions.filter((s) => !s.isCurrent);

  async function signOut(id: string) {
    setBusyId(id);
    const res = await revokeSessionAction({ sessionId: id });
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Signed out of that device.');
    router.refresh();
  }

  async function signOutOthers() {
    setBusyId('others');
    const res = await revokeOtherSessionsAction();
    setBusyId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Signed out of all other devices.');
    router.refresh();
  }

  function startEdit(s: SessionInfo) {
    setEditingId(s.id);
    setDraft(s.customName ?? '');
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft('');
  }

  async function saveName(id: string) {
    setSavingId(id);
    const res = await renameSessionAction({ sessionId: id, name: draft.trim() });
    setSavingId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setEditingId(null);
    setDraft('');
    toast.success(draft.trim() ? 'Device renamed.' : 'Custom name cleared.');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <ul className="divide-border divide-y rounded-md border">
        {sessions.map((s) => {
          const display = s.customName ?? s.label;
          const isEditing = editingId === s.id;
          return (
            <li key={s.id} className="flex items-center gap-3 px-3 py-3">
              <MonitorSmartphone className="text-muted-foreground h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus
                      value={draft}
                      maxLength={MAX_NAME}
                      placeholder={s.label}
                      aria-label="Device name"
                      disabled={savingId === s.id}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void saveName(s.id);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      className="h-8"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={savingId === s.id}
                      aria-label="Save device name"
                      onClick={() => void saveName(s.id)}
                    >
                      {savingId === s.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      disabled={savingId === s.id}
                      aria-label="Cancel"
                      onClick={cancelEdit}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{display}</span>
                      {s.isMfa && (
                        <ShieldCheck
                          className="h-3.5 w-3.5 text-[hsl(var(--accent))]"
                          aria-label="MFA verified"
                        />
                      )}
                      {s.isCurrent && (
                        <span className="rounded-full bg-[hsl(var(--accent)/0.12)] px-2 py-0.5 text-[10.5px] font-medium text-[hsl(var(--accent))]">
                          This device
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label="Rename device"
                        title="Rename device"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        onClick={() => startEdit(s)}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {s.customName ? `${s.label} · ` : ''}
                      {s.ip ?? 'unknown IP'} · active {formatLastActive(s.lastActiveAt)}
                    </div>
                  </>
                )}
              </div>
              {!s.isCurrent && !isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === s.id}
                  onClick={() => signOut(s.id)}
                >
                  {busyId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Sign out'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {others.length > 0 && (
        <Button variant="outline" size="sm" disabled={busyId === 'others'} onClick={signOutOthers}>
          {busyId === 'others' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            'Sign out all other devices'
          )}
        </Button>
      )}
      <p className="text-muted-foreground text-xs">
        Signing out takes effect immediately on devices that are online; a device
        that&apos;s offline is signed out within the hour.
      </p>
    </div>
  );
}
