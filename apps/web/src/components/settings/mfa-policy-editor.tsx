'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

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
    toast.success('MFA policy updated');
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
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || pending}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save policy'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setPolicy(current)}
            disabled={pending}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
