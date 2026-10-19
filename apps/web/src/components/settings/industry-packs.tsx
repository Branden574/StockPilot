'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { applyIndustryPackAction } from '@/server/actions/industry-pack';
import {
  MODULE_REGISTRY,
  modulesForPack,
  type DomainPack,
  type PackPreset,
} from '@stockpilot/core';

interface IndustryPacksProps {
  presets: PackPreset[];
  /** The org's currently-active domain pack (organizations.domain_pack). */
  activePack: DomainPack | null;
}

export function IndustryPacks({ presets, activePack }: IndustryPacksProps) {
  const router = useRouter();
  const [active, setActive] = React.useState<DomainPack | null>(activePack);
  const [confirm, setConfirm] = React.useState<PackPreset | null>(null);
  const [pending, startTransition] = React.useTransition();

  /** The non-core modules the confirmed pack would turn on (for the dialog). */
  const confirmModules = React.useMemo(() => {
    if (!confirm) return [];
    return modulesForPack(confirm.id)
      .filter((id) => MODULE_REGISTRY[id].tier !== 'core')
      .map((id) => MODULE_REGISTRY[id].title);
  }, [confirm]);

  function apply(preset: PackPreset) {
    startTransition(async () => {
      const res = await applyIndustryPackAction({ pack: preset.id });
      if (res.ok) {
        setActive(res.data.pack);
        setConfirm(null);
        // Soft RSC refresh so the module-derived sidebar nav reflects the newly
        // enabled modules immediately, without a manual reload.
        router.refresh();
        toast.success(`Set up as ${preset.label}.`);
      } else {
        toast.error(res.error.message);
      }
    });
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {presets.map((preset) => {
          const isActive = active === preset.id;
          return (
            <Card
              key={preset.id}
              className={cn(
                'flex h-full flex-col',
                isActive && 'border-foreground shadow-[0_0_0_1px_hsl(var(--foreground))]',
              )}
            >
              <CardHeader className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-[13.5px]">{preset.label}</CardTitle>
                  {isActive && <Badge>Active</Badge>}
                </div>
                <CardDescription className="text-[12.5px]">{preset.blurb}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  type="button"
                  variant={isActive ? 'outline' : 'default'}
                  disabled={pending}
                  onClick={() => setConfirm(preset)}
                >
                  {isActive ? 'Re-apply this setup' : 'Set up as this'}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up as {confirm?.label}?</DialogTitle>
            <DialogDescription asChild>
              <div className="text-muted-foreground space-y-2 text-[13px]">
                <p>
                  This turns on the modules for this industry and sets it as your active setup. It
                  will <span className="font-medium">not</span> turn off modules you already
                  enabled, and it keeps any labels you have already customized.
                </p>
                {confirmModules.length > 0 && (
                  <p>
                    Modules included:{' '}
                    <span className="text-foreground font-medium">{confirmModules.join(', ')}</span>
                    .
                  </p>
                )}
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
            <Button type="button" onClick={() => confirm && apply(confirm)} disabled={pending}>
              {pending ? 'Applying…' : 'Set up'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
