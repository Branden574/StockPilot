'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { updateOrgPoTermsAction } from '@/server/actions/organization';

interface PoTermsEditorProps {
  /** Current value from the organizations.po_terms column. */
  current: string | null;
}

/**
 * Edits organizations.po_terms — the free-form terms block printed at
 * the bottom of every PO PDF. Empty/whitespace-only saves clear the
 * block (server normalizes to null).
 */
export function PoTermsEditor({ current }: PoTermsEditorProps) {
  const router = useRouter();
  const [value, setValue] = React.useState(current ?? '');
  const [busy, setBusy] = React.useState(false);
  const baseline = current ?? '';
  const dirty = value !== baseline;

  async function save() {
    if (!dirty) return;
    setBusy(true);
    const r = await updateOrgPoTermsAction({
      poTerms: value.length === 0 ? null : value,
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    toast.success('Purchase order terms updated');
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="org-po-terms">Terms text</Label>
        <Textarea
          id="org-po-terms"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={6}
          maxLength={2000}
          placeholder={`e.g.\nNet 30 days. 2% discount if paid within 10 days.\nReturns require RMA. Damaged goods reported within 5 business days.\nSignature required upon delivery.`}
        />
        <p className="text-muted-foreground text-[11px]">
          Printed at the bottom of every PO PDF you send to suppliers — net-30
          / return policy / signature requirement / etc. Leave blank to omit.
        </p>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-[11px]">
          {value.length}/2000
        </span>
        <Button onClick={save} disabled={!dirty || busy} variant="gradient">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save terms'}
        </Button>
      </div>
    </div>
  );
}
