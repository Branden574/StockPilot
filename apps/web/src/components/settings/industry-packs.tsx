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
      <div className="grid gap-4 sm:grid-cols-2">
        {presets.map((preset) => {
          const isActive = active === preset.id;
          return (
            <Card
              key={preset.id}
              className={cn('h-full', isActive && 'border-primary ring-1 ring-primary')}
            >
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{preset.label}</CardTitle>
                  {isActive && <Badge>Active</Badge>}
                </div>
                <CardDescription>{preset.blurb}</CardDescription>
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
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This turns on the modules for this industry and sets it as your
                  active setup. It will <span className="font-medium">not</span>{' '}
                  turn off modules you already enabled, and it keeps any labels
                  you have already customized.
                </p>
                {confirmModules.length > 0 && (
                  <p>
                    Modules included:{' '}
                    <span className="font-medium text-foreground">
                      {confirmModules.join(', ')}
                    </span>
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
            <Button
              type="button"
              onClick={() => confirm && apply(confirm)}
              disabled={pending}
            >
              {pending ? 'Applying…' : 'Set up'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
