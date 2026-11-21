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
import { PasskeyButton } from '@/components/auth/passkey-button';
import { carriesBridgeName } from '@/lib/auth/passkey-bridge-name';
import { isControlFlow } from '@/lib/control-flow';
import { createClient } from '@/lib/supabase/client';
import { challengeFactorAction, stepUpMethodsAction } from '@/server/actions/mfa';

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

/** The same words the recount and confirm-count dialogs use when the request
 *  itself never got an answer. */
const NO_ANSWER_COPY = 'Could not reach the server. Try again.';
const FACTORS_UNREADABLE_COPY = 'Could not load your authenticator. Try again.';
/**
 * The account's only authenticator is its passkey's bridge (the server said
 * so: no app beside it). No app shows that code and the web cannot take a
 * passkey here yet, so the modal asks for no code at all: no code box, no
 * Verify, and the title and description say plainly that this confirmation
 * cannot be done here yet and what to do (review 2-3 finding 9, review B
 * finding 6). A recovery code is not offered: it removes every sign-in
 * method, too much for one confirmation. The passkey replaces it later.
 */
const BRIDGE_ONLY_TITLE = "Confirm it's you";
/** Stage 4: the account's passkey answers here (plan section 4). */
const PASSKEY_ONLY_COPY = 'This action needs a fresh check. Use your passkey.';
const PASSKEY_AND_APP_COPY =
  'This action needs a fresh check. Use your passkey, or enter the 6-digit code from your authenticator app.';
const BRIDGE_ONLY_COPY =
  "This confirmation can't be done here yet, so close this and ask your organization's owner or StockPilot support for help.";

/**
 * Stacking: the modal is usually opened from inside another dialog (Restore,
 * Remove organization, Disable account), so its panel sits one layer above
 * the dialog layer (z-50) on its own, whatever order the two were mounted in;
 * its scrim then dims the dialog under it. Same surface in light and dark.
 */
const ABOVE_DIALOGS = 'z-[60]';

function StepUpModal({ open, onDone }: { open: boolean; onDone: (ok: boolean) => void }) {
  const [factors, setFactors] = React.useState<Factor[] | null>(null);
  const [factorId, setFactorId] = React.useState('');
  const [code, setCode] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** The server answered that the account's only authenticator is the passkey's bridge. */
  const [bridgeOnly, setBridgeOnly] = React.useState(false);
  /** The server answered that the account's passkey answers here (stage 4). */
  const [passkey, setPasskey] = React.useState(false);

  /** Every way out clears the typed code and the last error, so the next
   *  opening starts clean. */
  function done(ok: boolean) {
    setCode('');
    setError(null);
    setBridgeOnly(false);
    setPasskey(false);
    onDone(ok);
  }

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createClient();
        const { data, error: listError } = await supabase.auth.mfa.listFactors();
        if (cancelled) return;
        // An unreadable list is not "no authenticator": say it could not be
        // read (the words the thrown case already used), never that nothing
        // is enrolled.
        if (listError) {
          setFactors(null);
          setFactorId('');
          setError(FACTORS_UNREADABLE_COPY);
          return;
        }
        const verified = (data?.totp ?? []).filter((f) => f.status === 'verified');
        let totp: Factor[] = verified.map((f) => ({
          id: f.id,
          friendlyName: f.friendly_name ?? null,
        }));
        // A factor with the passkey bridge's reserved name: only the server
        // knows whether it is the account's bridge, whose code no app shows,
        // so it is asked once for the account's apps. A factor of that name
        // is never offered for a code here, whatever the server answered
        // (fail closed; the code check refuses it too).
        if (verified.some(carriesBridgeName)) {
          let methods: Awaited<ReturnType<typeof stepUpMethodsAction>> | null = null;
          try {
            methods = await stepUpMethodsAction();
          } catch (e) {
            // A redirect: the router is already on its way.
            if (isControlFlow(e)) return;
          }
          if (cancelled) return;
          if (methods?.ok) {
            totp = methods.data.apps;
            if (methods.data.passkey) {
              // The passkey answers here: its button, and the apps' code box
              // beside it when there are apps (no "nothing enrolled" line).
              setPasskey(true);
              setFactors(totp);
              setFactorId(totp[0]?.id ?? '');
              return;
            }
            if (totp.length === 0) {
              if (methods.data.recordsUnread) {
                // The bridge record could not be read just now: a passing
                // fault, said in the words of a list that could not load.
                setFactors(null);
                setFactorId('');
                setError(FACTORS_UNREADABLE_COPY);
                return;
              }
              setFactors(totp);
              setFactorId('');
              setBridgeOnly(true);
              return;
            }
          } else {
            // No answer: the browser's own list without the reserved-name
            // factors (fail closed: which of them is the bridge is not
            // known, and no member has a code for any of them). With no app
            // left, the words of a list that could not load.
            totp = totp.filter((f) => !carriesBridgeName({ friendly_name: f.friendlyName }));
            if (totp.length === 0) {
              setFactors(null);
              setFactorId('');
              setError(FACTORS_UNREADABLE_COPY);
              return;
            }
          }
        }
        setFactors(totp);
        setFactorId(totp[0]?.id ?? '');
        if (totp.length === 0) {
          setError('No authenticator is enrolled. Add one in Settings → Security first.');
        }
      } catch (e) {
        // A redirect from the server call above: the router is on its way.
        if (isControlFlow(e)) return;
        if (!cancelled) setError(FACTORS_UNREADABLE_COPY);
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
    let res: Awaited<ReturnType<typeof challengeFactorAction>>;
    try {
      res = await challengeFactorAction({ factorId, code });
    } catch (e) {
      // A redirect (the session ended): the router is already on its way to
      // sign-in, so nothing is shown here.
      if (isControlFlow(e)) return;
      // The request itself failed (a dropped connection, a deploy that no
      // longer has the action). It used to leave the modal spinning with
      // Cancel disabled and no way out but a reload; now it says so, and the
      // code can be sent again or the modal closed.
      setError(NO_ANSWER_COPY);
      return;
    } finally {
      setPending(false);
    }
    if (!res.ok) {
      setError(res.error.message);
      setCode('');
      return;
    }
    done(true);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !pending) done(false);
      }}
    >
      <DialogContent className={ABOVE_DIALOGS} data-glass-role="step-up">
        <DialogHeader data-glass="step-up-head">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="text-muted-foreground h-5 w-5" />
            {bridgeOnly || passkey ? BRIDGE_ONLY_TITLE : <>Confirm with your authenticator</>}
          </DialogTitle>
          {bridgeOnly ? (
            <DialogDescription>{BRIDGE_ONLY_COPY}</DialogDescription>
          ) : passkey ? (
            <DialogDescription>
              {factors && factors.length > 0 ? PASSKEY_AND_APP_COPY : PASSKEY_ONLY_COPY}
            </DialogDescription>
          ) : (
            <DialogDescription>
              This action needs a fresh two-factor check. Enter the current 6-digit code from your
              authenticator app — you won&apos;t be signed out.
            </DialogDescription>
          )}
        </DialogHeader>
        <form data-glass="step-up-form" onSubmit={submit} className="space-y-3">
          {passkey ? <PasskeyButton onPassed={() => done(true)} showHint={false} /> : null}
          {factors && factors.length > 1 ? (
            <div data-glass="step-up-field" className="space-y-1.5">
              <Label htmlFor="stepup-factor">Authenticator</Label>
              <select
                id="stepup-factor"
                value={factorId}
                onChange={(e) => {
                  setFactorId(e.target.value);
                  setCode('');
                }}
                className="bg-card text-foreground focus-visible:ring-ring focus-visible:ring-offset-background h-11 w-full rounded-md border border-[var(--ed-line-strong)] px-2.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:h-8 sm:text-[13px]"
              >
                {factors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.friendlyName ?? `Authenticator (${f.id.slice(0, 6)})`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {bridgeOnly || (passkey && !factors?.length) ? null : (
            <div data-glass="step-up-field" className="space-y-1.5">
              <Label htmlFor="stepup-code">Authentication code</Label>
              <Input
                id="stepup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="123456"
                value={code}
                // Digits only, the first six. No maxLength: a browser cuts a pasted
                // "123 456" at six characters before this runs, leaving five digits.
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="font-mono tracking-widest"
              />
            </div>
          )}
          {error ? (
            <p className="text-destructive text-[12px]" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter data-glass="step-up-foot">
            <Button type="button" variant="outline" onClick={() => done(false)} disabled={pending}>
              Cancel
            </Button>
            {bridgeOnly || (passkey && !factors?.length) ? null : (
              <Button type="submit" disabled={pending || code.length !== 6 || !factorId}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
