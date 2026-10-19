'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { SettingsPanel } from '@/components/settings/settings-nav';
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
import { Switch } from '@/components/ui/switch';
import { setModuleEnabledAction } from '@/server/actions/module-settings';
import { computeModuleChangeSet, MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

interface ModuleRow {
  id: ModuleId;
  title: string;
  tier: 'core' | 'optional' | 'premium';
}

interface ModuleTogglesProps {
  modules: ModuleRow[];
  enabledIds: ModuleId[];
  /**
   * The organization is comped: every module is usable whatever a switch says.
   * The switches still decide what runs on its own, so they stay operable, and
   * the copy stops calling an included module "disabled".
   */
  comped?: boolean;
}

interface PendingConfirm {
  moduleId: ModuleId;
  next: boolean;
  /** The OTHER modules that will also change (not the primary one). */
  affected: ModuleId[];
}

export function ModuleToggles({ modules, enabledIds, comped = false }: ModuleTogglesProps) {
  const router = useRouter();
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
        // Re-render the server tree (dashboard layout → DashboardShell →
        // Sidebar) so the module-derived nav adds/removes the link IMMEDIATELY,
        // without a manual reload. The optimistic setEnabled above only updates
        // this settings list; the sidebar reads its module set on the server,
        // so it needs this soft RSC refresh to reflect the toggle live.
        router.refresh();
        toast.success(
          next
            ? `${MODULE_REGISTRY[moduleId].title} enabled.`
            : comped
              ? `${MODULE_REGISTRY[moduleId].title} switched off. It stays available in the app because every module is included.`
              : `${MODULE_REGISTRY[moduleId].title} disabled.`,
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
      <div className="flex flex-col gap-4">
        <TierSection
          title="Core"
          subtitle="These modules are always on and cannot be disabled."
          modules={coreModules}
          enabled={enabled}
          savingId={savingId}
          locked={locked}
          onToggle={handleToggle}
          comped={comped}
        />
        <TierSection
          title="Optional"
          subtitle="Turn these on or off to match your workflow."
          modules={optionalModules}
          enabled={enabled}
          savingId={savingId}
          locked={locked}
          onToggle={handleToggle}
          comped={comped}
        />
        {premiumModules.length > 0 && (
          <TierSection
            title="Premium"
            subtitle={
              comped
                ? 'Included for your organization.'
                : 'Plan-gated modules. Contact us to upgrade.'
            }
            modules={premiumModules}
            enabled={enabled}
            savingId={savingId}
            locked={locked}
            onToggle={handleToggle}
            comped={comped}
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
              {confirm?.next ? 'Enable' : comped ? 'Switch off' : 'Disable'}{' '}
              {confirm ? MODULE_REGISTRY[confirm.moduleId].title : ''}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-muted-foreground space-y-2 text-[13px]">
                <p>
                  This will also{' '}
                  <span className="font-medium">
                    {confirm?.next ? 'enable' : comped ? 'switch off' : 'disable'}
                  </span>
                  {': '}
                  {confirm?.affected.map((id) => MODULE_REGISTRY[id].title).join(', ')}.
                </p>
                {comped && !confirm?.next ? (
                  <p>
                    They stay available to your team in the app, because every module is included.
                    What stops is what they run on their own.
                  </p>
                ) : null}
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
  comped: boolean;
}

function TierSection({
  title,
  subtitle,
  modules,
  enabled,
  savingId,
  locked,
  onToggle,
  comped,
}: TierSectionProps) {
  if (modules.length === 0) return null;
  return (
    <SettingsPanel title={title} description={subtitle} flush>
      <ul className="divide-border divide-y">
        {modules.map((m) => {
          const isCore = m.tier === 'core';
          const checked = isCore || enabled.has(m.id);
          const busy = savingId === m.id;
          return (
            <li
              key={m.id}
              className="flex min-h-[52px] items-center justify-between gap-6 px-[18px] py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium">{m.title}</span>
                  {m.tier === 'premium' && <Badge variant="outline">Premium</Badge>}
                  {comped && !isCore && !checked && <Badge variant="outline">Included</Badge>}
                </div>
              </div>
              {isCore ? (
                <span className="text-muted-foreground shrink-0 text-[12.5px]">Always on</span>
              ) : (
                // Every switch is locked while a save is out or the cascade
                // confirm is open. The one being saved stays focusable
                // (pending) so a keyboard user is not dropped; the rest are
                // disabled, as before.
                <Switch
                  checked={checked}
                  label={`Toggle ${m.title}`}
                  pending={busy}
                  disabled={locked && !busy}
                  onCheckedChange={(next) => {
                    if (!busy && !locked) onToggle(m.id, next);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </SettingsPanel>
  );
}
