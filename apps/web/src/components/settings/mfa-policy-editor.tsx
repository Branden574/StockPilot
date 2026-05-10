'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { setOrgMfaPolicyAction } from '@/server/actions/mfa';

type Policy = 'optional' | 'admins_required' | 'all_required';

const OPTIONS: Array<{
  value: Policy;
  label: string;
  description: string;
}> = [
  {
    value: 'optional',
    label: 'Optional',
    description: 'Members may enroll an authenticator if they want.',
  },
  {
    value: 'admins_required',
    label: 'Required for admins',
    description: 'Owners and Super Admins must have MFA enrolled.',
  },
  {
    value: 'all_required',
    label: 'Required for everyone',
    description: 'Every member is forced to enroll on next sign-in.',
  },
];

export function MfaPolicyEditor({ current }: { current: Policy }) {
  const router = useRouter();
  const [policy, setPolicy] = React.useState<Policy>(current);
  const [pending, setPending] = React.useState(false);
  const dirty = policy !== current;

  async function save() {
    setPending(true);
    const res = await setOrgMfaPolicyAction({ policy });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('MFA policy updated.');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" className="space-y-2">
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className={
              'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ' +
              (policy === o.value
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted/40')
            }
          >
            <input
              type="radio"
              name="mfa-policy"
              value={o.value}
              checked={policy === o.value}
              onChange={() => setPolicy(o.value)}
              className="mt-1"
            />
            <div className="flex-1">
              <Label className="cursor-pointer font-medium">{o.label}</Label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{o.description}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setPolicy(current)}
            disabled={pending}
          >
            Discard
          </Button>
        )}
        <Button
          type="button"
          variant="gradient"
          onClick={save}
          disabled={!dirty || pending}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save policy'}
        </Button>
      </div>
    </div>
  );
}
