import Link from 'next/link';
import { Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

interface ModuleNotEnabledProps {
  moduleId: ModuleId;
  canManage: boolean;
}

/**
 * Rendered by a module's dashboard page when the module is disabled for the
 * org. Shown in place of the normal page content — no data fetch happens.
 */
export function ModuleNotEnabled({ moduleId, canManage }: ModuleNotEnabledProps) {
  const title = MODULE_REGISTRY[moduleId].title;
  return (
    <div className="container mx-auto flex max-w-2xl items-center justify-center px-4 py-20 sm:px-6">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">
              {title} isn&apos;t enabled
            </h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              This module isn&apos;t turned on for your organization.
            </p>
          </div>
          {canManage ? (
            <Button asChild variant="gradient" className="mt-2">
              <Link href="/dashboard/settings/modules">Enable in Settings → Modules</Link>
            </Button>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Ask an owner or admin to enable it.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
