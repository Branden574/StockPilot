'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { renameOrganizationAction } from '@/server/actions/organization';

export function OrgNameEditor({ current }: { current: string }) {
  const router = useRouter();
  const [name, setName] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  const dirty = name.trim() !== current.trim() && name.trim().length > 0;

  async function save() {
    if (!dirty) return;
    setBusy(true);
    const r = await renameOrganizationAction({ name: name.trim() });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Organization name updated');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="org-name">Name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Your organization"
        />
        <p className="text-muted-foreground text-[11px]">
          Shown in the sidebar header and on every email sent from your
          workspace.
        </p>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || busy} variant="gradient">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save name'}
        </Button>
      </div>
    </div>
  );
}
