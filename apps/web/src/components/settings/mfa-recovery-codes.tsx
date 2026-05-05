'use client';

import { Copy, Download, Loader2, ShieldAlert } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { generateMfaRecoveryCodesAction } from '@/server/actions/mfa-recovery';

interface MfaRecoveryCodesProps {
  total: number;
  unused: number;
}

export function MfaRecoveryCodes({ total, unused }: MfaRecoveryCodesProps) {
  const [open, setOpen] = React.useState(false);
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function generate() {
    setBusy(true);
    const r = await generateMfaRecoveryCodesAction();
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message);
      return;
    }
    setCodes(r.data.codes);
    setOpen(true);
  }

  async function copyAll() {
    if (!codes) return;
    await navigator.clipboard.writeText(codes.join('\n'));
    toast.success('Codes copied to clipboard');
  }

  function download() {
    if (!codes) return;
    const blob = new Blob(
      [
        'StockPilot recovery codes\n',
        'Each code is single-use. Store in a safe place.\n\n',
        codes.join('\n'),
        '\n',
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stockpilot-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function close() {
    setOpen(false);
    // Hold the codes in memory until next mount so the user has a chance
    // to scroll back up and copy/download. Cleared on page navigation.
  }

  const lowOnCodes = total > 0 && unused <= 2;

  return (
    <div className="space-y-3">
      <div className="text-sm">
        {total === 0 ? (
          <p className="text-muted-foreground">
            You don't have any recovery codes yet. Generate a set of 10 codes
            you can use if you ever lose access to your authenticator.
          </p>
        ) : (
          <p className="text-muted-foreground">
            {unused} of {total} recovery codes remaining.{' '}
            {lowOnCodes && (
              <span className="text-warning font-medium">
                Generate a fresh set soon — you're running low.
              </span>
            )}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={generate} disabled={busy} variant="outline">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
          {total === 0 ? 'Generate codes' : 'Regenerate codes'}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your recovery codes</DialogTitle>
            <DialogDescription>
              Each code works once. Keep them somewhere safe — a password
              manager works well. They're not retrievable after this dialog
              closes.
            </DialogDescription>
          </DialogHeader>

          {codes && (
            <div className="border-border bg-muted/40 rounded-md border p-3 font-mono text-sm">
              <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 tabular-nums">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={copyAll}>
              <Copy className="h-4 w-4" /> Copy all
            </Button>
            <Button variant="outline" onClick={download}>
              <Download className="h-4 w-4" /> Download .txt
            </Button>
          </div>

          <DialogFooter>
            <Button onClick={close}>I've saved them</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
