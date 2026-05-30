'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { setModuleEnabledAction } from '@/server/actions/module-settings';
import { computeModuleChangeSet, MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

interface ModuleRow {
  id: ModuleId;
  title: string;
  description: string;
  tier: 'core' | 'optional' | 'premium';
}

interface ModuleTogglesProps {
  modules: ModuleRow[];
  enabledIds: ModuleId[];
}

interface PendingConfirm {
  moduleId: ModuleId;
  next: boolean;
  /** The OTHER modules that will also change (not the primary one). */
  affected: ModuleId[];
}

export function ModuleToggles({ modules, enabledIds }: ModuleTogglesProps) {
  const [enabled, setEnabled] = React.useState<Set<ModuleId>>(() => new Set(enabledIds));
  const [pending, startTransition] = React.useTransition();
  // Which module toggle is currently in-flight, so we can grey it out.
  const [savingId, setSavingId] = React.useState<ModuleId | null>(null);
  // Confirm dialog state.
  const [confirm, setConfirm] = React.useState<PendingConfirm | null>(null);

  const coreModules = modules.filter((m) => m.tier === 'core');
  const optionalModules = modules.filter((m) => m.tier === 'optional');
  const premiumModules = modules.filter((m) => m.tier === 'premium');

  // Serialize toggles: while a save is in flight (or a confirm dialog is open),
  // lock every switch so a second toggle can't race the first and apply against
  // a stale `enabled` snapshot.
  const locked = pending || confirm !== null;

  /** Apply a toggle (after any confirm). */
  function applyToggle(moduleId: ModuleId, next: boolean) {
    // Optimistic: apply the full change set locally immediately.
    const changes = computeModuleChangeSet(new Set(enabled), moduleId, next);
    setEnabled((prev) => {
      const next2 = new Set(prev);
      for (const c of changes) c.enabled ? next2.add(c.moduleId) : next2.delete(c.moduleId);
      return next2;
    });
    setSavingId(moduleId);

    startTransition(async () => {
      const res = await setModuleEnabledAction({ moduleId, enabled: next });
      setSavingId(null);
      if (res.ok) {
        setEnabled(new Set(res.data.enabled));
        toast.success(
          next ? `${MODULE_REGISTRY[moduleId].title} enabled.` : `${MODULE_REGISTRY[moduleId].title} disabled.`,
        );
      } else {
        // Revert the optimistic update.
        setEnabled((prev) => {
          const reverted = new Set(prev);
          for (const c of changes) {
            // Undo each change: flip it back.
            c.enabled ? reverted.delete(c.moduleId) : reverted.add(c.moduleId);
          }
          return reverted;
        });
        toast.error(res.error.message);
      }
    });
  }

  /** Called when a user flips a Switch on an optional/premium module. */
  function handleToggle(moduleId: ModuleId, next: boolean) {
    const changes = computeModuleChangeSet(new Set(enabled), moduleId, next);
    // Changes includes the primary module; filter to the "also affected" set.
    const others = changes.filter((c) => c.moduleId !== moduleId).map((c) => c.moduleId);
    if (others.length > 0) {
      setConfirm({ moduleId, next, affected: others });
    } else {
      applyToggle(moduleId, next);
    }
  }

  return (
    <>
      <div className="space-y-8">
        <TierSection
          title="Core"
          subtitle="These modules are always on and cannot be disabled."
          modules={coreModules}
          enabled={enabled}
          savingId={savingId}
          locked={locked}
          onToggle={handleToggle}
        />
        <TierSection
          title="Optional"
          subtitle="Turn these on or off to match your workflow."
          modules={optionalModules}
          enabled={enabled}
          savingId={savingId}
          locked={locked}
          onToggle={handleToggle}
        />
        {premiumModules.length > 0 && (
          <TierSection
            title="Premium"
            subtitle="Plan-gated modules. Contact us to upgrade."
            modules={premiumModules}
            enabled={enabled}
            savingId={savingId}
            locked={locked}
            onToggle={handleToggle}
          />
        )}
      </div>

      {/* Cascade-confirm dialog */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.next ? 'Enable' : 'Disable'}{' '}
              {confirm ? MODULE_REGISTRY[confirm.moduleId].title : ''}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This will also{' '}
                  <span className="font-medium">
                    {confirm?.next ? 'enable' : 'disable'}
                  </span>
                  {': '}
                  {confirm?.affected
                    .map((id) => MODULE_REGISTRY[id].title)
                    .join(', ')}
                  .
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirm(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={pending}
              onClick={() => {
                if (!confirm) return;
                const { moduleId, next } = confirm;
                setConfirm(null);
                applyToggle(moduleId, next);
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface TierSectionProps {
  title: string;
  subtitle: string;
  modules: ModuleRow[];
  enabled: Set<ModuleId>;
  savingId: ModuleId | null;
  /** True while any toggle is saving or a confirm is open — disables every switch. */
  locked: boolean;
  onToggle: (id: ModuleId, next: boolean) => void;
}

function TierSection({ title, subtitle, modules, enabled, savingId, locked, onToggle }: TierSectionProps) {
  if (modules.length === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-muted-foreground text-xs">{subtitle}</p>
      </div>
      <div className="divide-border divide-y rounded-md border">
        {modules.map((m) => {
          const isCore = m.tier === 'core';
          const checked = isCore || enabled.has(m.id);
          const busy = savingId === m.id;
          return (
            <div
              key={m.id}
              className={cn(
                'flex items-center justify-between gap-6 px-4 py-3',
                busy && 'opacity-60',
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{m.title}</span>
                  {m.tier === 'premium' && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      Premium
                    </Badge>
                  )}
                </div>
                {m.description ? (
                  <div className="text-muted-foreground text-xs">{m.description}</div>
                ) : null}
              </div>
              {isCore ? (
                <span className="text-muted-foreground text-xs shrink-0">Always on</span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  aria-label={`Toggle ${m.title}`}
                  onClick={() => !busy && !locked && onToggle(m.id, !checked)}
                  disabled={busy || locked}
                  className={cn(
                    'relative shrink-0 mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition-colors',
                    checked ? 'bg-primary' : 'bg-muted',
                    (busy || locked) && 'cursor-not-allowed',
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
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
