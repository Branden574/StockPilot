'use client';

import { Loader2, ShieldCheck } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { challengeFactorAction } from '@/server/actions/mfa';

interface Factor {
  id: string;
  friendlyName: string | null;
}

/**
 * Reusable MFA step-up for sensitive admin actions gated on a FRESH AAL2 check.
 *
 * When such an action returns `aal2_required`, instead of forcing a full
 * re-sign-in, call `ensure()`: it opens a modal asking for the current 6-digit
 * authenticator code, verifies it via `challengeFactorAction` (which steps the
 * session up to fresh AAL2 server-side — NO sign-out), and resolves `true`.
 * Retry the action after a `true`; the fresh step-up now passes.
 *
 * Usage:
 *   const stepUp = useStepUp();
 *   ... let res = await someAction(x);
 *       if (!res.ok && res.error.details?.reason === 'aal2_required') {
 *         if (await stepUp.ensure()) res = await someAction(x); else return;
 *       }
 *   ... render {stepUp.modal}
 */
export function useStepUp() {
  const [open, setOpen] = React.useState(false);
  const resolverRef = React.useRef<((ok: boolean) => void) | null>(null);

  const ensure = React.useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOpen(true);
    });
  }, []);

  const finish = React.useCallback((ok: boolean) => {
    setOpen(false);
    const r = resolverRef.current;
    resolverRef.current = null;
    r?.(ok);
  }, []);

  const modal = <StepUpModal open={open} onDone={finish} />;
  return { ensure, modal };
}

function StepUpModal({ open, onDone }: { open: boolean; onDone: (ok: boolean) => void }) {
  const [factors, setFactors] = React.useState<Factor[] | null>(null);
  const [factorId, setFactorId] = React.useState('');
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setCode('');
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.mfa.listFactors();
        const totp = (data?.totp ?? [])
          .filter((f) => f.status === 'verified')
          .map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null }));
        if (cancelled) return;
        setFactors(totp);
        setFactorId(totp[0]?.id ?? '');
        if (totp.length === 0) {
          setError('No authenticator is enrolled. Add one in Settings → Security first.');
        }
      } catch {
        if (!cancelled) setError('Could not load your authenticator. Try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId || code.length !== 6) return;
    setPending(true);
    setError(null);
    const res = await challengeFactorAction({ factorId, code });
    setPending(false);
    if (!res.ok) {
      setError(res.error.message);
      setCode('');
      return;
    }
    onDone(true);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !pending) onDone(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="text-muted-foreground h-5 w-5" />
            Confirm with your authenticator
          </DialogTitle>
          <DialogDescription>
            This action needs a fresh two-factor check. Enter the current 6-digit code from your
            authenticator app — you won&apos;t be signed out.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {factors && factors.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="stepup-factor">Authenticator</Label>
              <select
                id="stepup-factor"
                value={factorId}
                onChange={(e) => {
                  setFactorId(e.target.value);
                  setCode('');
                }}
                className="border-border bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                {factors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.friendlyName ?? `Authenticator (${f.id.slice(0, 6)})`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="stepup-code">Authentication code</Label>
            <Input
              id="stepup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="font-mono tracking-widest"
            />
          </div>
          {error ? (
            <p className="text-destructive text-[12px]" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onDone(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || code.length !== 6 || !factorId}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
