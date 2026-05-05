'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateProfileNameAction } from '@/server/actions/profile';

export function ProfileNameEditor({ current }: { current: string }) {
  const router = useRouter();
  const [name, setName] = React.useState(current);
  const [busy, setBusy] = React.useState(false);
  const dirty = name.trim() !== current.trim();

  async function save() {
    if (!dirty) return;
    setBusy(true);
    const trimmed = name.trim();
    const r = await updateProfileNameAction({
      fullName: trimmed.length === 0 ? null : trimmed,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Profile updated');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="profile-name">Full name</Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Your name"
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={save} disabled={!dirty || busy} variant="gradient">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save name'}
        </Button>
      </div>
    </div>
  );
}
