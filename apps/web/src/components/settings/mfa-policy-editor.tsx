'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
    <div className="space-y-4">
      <RadioGroup
        variant="card"
        aria-label="Organization MFA policy"
        value={policy}
        onValueChange={(v) => setPolicy(v as Policy)}
      >
        {OPTIONS.map((o) => (
          <RadioGroupItem
            key={o.value}
            value={o.value}
            label={o.label}
            description={o.description}
          />
        ))}
      </RadioGroup>
      <div className="flex flex-wrap items-center justify-end gap-2">
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
        <Button type="button" variant="gradient" onClick={save} disabled={!dirty || pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Save policy
        </Button>
      </div>
    </div>
  );
}
