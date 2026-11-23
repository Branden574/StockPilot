'use client';

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { KeyRound, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { isControlFlow } from '@/lib/control-flow';
import {
  consumeMfaRecoveryCodeAction,
  generateMfaRecoveryCodesAction,
} from '@/server/actions/mfa-recovery';
import {
  finishAddPasskeyAction,
  finishPasskeySetupAction,
  removePasskeyAction,
  renamePasskeyAction,
  startAddPasskeyAction,
  startConfirmAddAction,
  startPasskeySetupAction,
} from '@/server/actions/passkeys';

import type { PasskeysPanel as PanelData } from '@/server/security/passkeys';

import { addPasskeyBeforeWords, PASSKEYS_PANEL_WORDS } from './passkeys-copy';

const dateOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' }) : null;

type Step = 'phone' | 'before' | 'proof' | 'name' | 'codes' | 'done';

/**
 * Settings, Security: the Passkeys panel (plan section 4). The page renders
 * it only when the server answered (server/security/passkeys.ts
 * passkeysPanelFor): Add only when the server says a passkey can be added,
 * Finish only when it says a setup can be finished, and with `listOnly` the
 * member's passkeys with Remove and one sentence, nothing else (decision A).
 */
export function PasskeysPanel({ data }: { data: PanelData }) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [recovering, setRecovering] = React.useState(false);

  async function finishSetup(id: string) {
    setBusyId(id);
    setRowError(null);
    try {
      const start = await startPasskeySetupAction();
      if (!start.ok) return setRowError(start.error.message);
      if (start.data.kind !== 'options') return router.refresh();
      let response: unknown;
      try {
        response = await startAuthentication({ optionsJSON: start.data.optionsJSON as never });
      } catch {
        return setRowError(PASSKEYS_PANEL_WORDS.cancelled);
      }
      const done = await finishPasskeySetupAction({ challengeId: start.data.challengeId, response });
      if (!done.ok) return setRowError(done.error.message);
      router.refresh();
    } catch (e) {
      if (isControlFlow(e)) return;
      setRowError(PASSKEYS_PANEL_WORDS.noAnswer);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setBusyId(id);
    setRowError(null);
    try {
      const r = await removePasskeyAction({ passkeyId: id });
      if (!r.ok) return setRowError(r.error.message);
      setRemoving(null);
      router.refresh();
    } catch (e) {
      if (isControlFlow(e)) return;
      setRowError(PASSKEYS_PANEL_WORDS.noAnswer);
    } finally {
      setBusyId(null);
    }
  }

  async function rename() {
    if (!renaming) return;
    setBusyId(renaming.id);
    setRowError(null);
    try {
      const r = await renamePasskeyAction({ passkeyId: renaming.id, name: renaming.name });
      if (!r.ok) return setRowError(r.error.message);
      setRenaming(null);
      router.refresh();
    } catch (e) {
      if (isControlFlow(e)) return;
      setRowError(PASSKEYS_PANEL_WORDS.noAnswer);
    } finally {
      setBusyId(null);
    }
  }

  const full = data.listOnly === null;

  return (
    <div className="space-y-3" data-passkeys-panel="">
      {data.listOnly ? (
        <p className="text-muted-foreground text-[13px]">
          {data.listOnly === 'turned_off' ? PASSKEYS_PANEL_WORDS.turnedOff : PASSKEYS_PANEL_WORDS.unavailable}
        </p>
      ) : null}
      {data.passkeys.length > 0 ? (
        <ul className="divide-border divide-y rounded-lg border">
          {data.passkeys.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-[13px]">
                <p className="font-medium">{p.name}</p>
                <p className="text-muted-foreground text-[12px]">
                  {p.unfinished
                    ? PASSKEYS_PANEL_WORDS.unfinished
                    : `Added ${dateOf(p.createdAt)} · ${p.lastUsedAt ? `Last used ${dateOf(p.lastUsedAt)}` : PASSKEYS_PANEL_WORDS.notUsed} · ${p.backedUp ? PASSKEYS_PANEL_WORDS.synced : PASSKEYS_PANEL_WORDS.oneDevice}`}
                </p>
              </div>
              <div className="flex gap-2">
                {!full ? null : p.unfinished ? (
                  data.canFinish ? (
                    <Button size="sm" onClick={() => finishSetup(p.id)} disabled={busyId !== null}>
                      Finish
                    </Button>
                  ) : null
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRenaming({ id: p.id, name: p.name })}
                    disabled={busyId !== null || !data.aal2}
                  >
                    Rename
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRemoving(p.id)}
                  disabled={busyId !== null || !data.aal2}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!data.aal2 && data.passkeys.length > 0 ? (
        data.onlyMethodUnfinished ? (
          // Review 4 finding 4: no second step to confirm with; the two ways out.
          <div className="space-y-2">
            <p className="text-muted-foreground text-[12px]">
              {PASSKEYS_PANEL_WORDS.onlyMethodUnfinished}
            </p>
            <Button size="sm" variant="outline" onClick={() => setRecovering(true)}>
              {PASSKEYS_PANEL_WORDS.useRecoveryCode}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-[12px]">{PASSKEYS_PANEL_WORDS.stepUp}</p>
        )
      ) : null}
      <div role="alert">{rowError ? <p className="text-destructive text-[12px]">{rowError}</p> : null}</div>
      {!full || !data.canAdd ? null : data.addBlocked ? (
        // The second lab walk, FAIL 2: no Add can finish; the ways out.
        <div className="space-y-2">
          <p className="text-muted-foreground text-[12px]">{PASSKEYS_PANEL_WORDS.addBlocked}</p>
          <Button size="sm" variant="outline" onClick={() => setRecovering(true)}>
            {PASSKEYS_PANEL_WORDS.useRecoveryCode}
          </Button>
        </div>
      ) : data.atLimit ? (
        <p className="text-muted-foreground text-[12px]">{PASSKEYS_PANEL_WORDS.atLimit}</p>
      ) : (
        <Button size="sm" onClick={() => setAdding(true)}>
          <KeyRound className="h-4 w-4" />
          {PASSKEYS_PANEL_WORDS.add}
        </Button>
      )}

      {recovering ? <RecoveryCodeDialog onClose={() => setRecovering(false)} /> : null}

      {adding ? (
        <AddPasskeyDialog
          data={data}
          onClose={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}

      <Dialog open={renaming !== null} onOpenChange={(o) => (!o ? setRenaming(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
            <DialogDescription>Give it a name you will know it by.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Passkey name"
            value={renaming?.name ?? ''}
            maxLength={60}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={rename} disabled={busyId !== null}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(o) => (!o ? setRemoving(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove passkey</DialogTitle>
            <DialogDescription>{PASSKEYS_PANEL_WORDS.removeConfirm}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => removing && remove(removing)} disabled={busyId !== null}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The Add flow: the phone screen, the warnings, the proof, the name, the device prompt. */
function AddPasskeyDialog({ data, onClose }: { data: PanelData; onClose: () => void }) {
  const [step, setStep] = React.useState<Step>(data.phoneConfirmation ? 'phone' : 'before');
  const [typed, setTyped] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [factorId, setFactorId] = React.useState(data.apps[0]?.id ?? '');
  const [useCode, setUseCode] = React.useState(data.proof === 'code');
  const [name, setName] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [proofAnswer, setProofAnswer] = React.useState<unknown>(null);
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [saved, setSaved] = React.useState(false);
  const mustSaveCodes = data.proof === 'password';

  async function proveWithPasskey(): Promise<unknown | null> {
    const start = await startConfirmAddAction();
    if (!start.ok) {
      setError(start.error.message);
      return null;
    }
    if (start.data.kind !== 'options') return null;
    try {
      const response = await startAuthentication({ optionsJSON: start.data.optionsJSON as never });
      return { kind: 'passkey', challengeId: start.data.challengeId, response };
    } catch {
      setError(PASSKEYS_PANEL_WORDS.cancelled);
      return null;
    }
  }

  async function proofNext() {
    setError(null);
    if (data.proof === 'password') {
      setProofAnswer({ kind: 'password', password });
    } else if (useCode || data.proof === 'code') {
      setProofAnswer({ kind: 'code', factorId, code });
    } else {
      setPending(true);
      try {
        const answer = await proveWithPasskey();
        if (!answer) return;
        setProofAnswer(answer);
      } finally {
        setPending(false);
      }
    }
    setStep('name');
  }

  async function add() {
    setError(null);
    let supported = false;
    try {
      supported = browserSupportsWebAuthn();
    } catch {
      supported = false;
    }
    if (!supported) return setError(PASSKEYS_PANEL_WORDS.noSupport);
    setPending(true);
    try {
      const start = await startAddPasskeyAction({
        proof: proofAnswer,
        phoneConfirmation: data.phoneConfirmation ? typed : undefined,
      });
      if (!start.ok) {
        setError(start.error.message);
        // A proof that was refused or spent is asked again.
        setStep('proof');
        return;
      }
      let response: unknown;
      try {
        response = await startRegistration({ optionsJSON: start.data.optionsJSON as never });
      } catch {
        return setError(PASSKEYS_PANEL_WORDS.cancelled);
      }
      const finish = await finishAddPasskeyAction({ challengeId: start.data.challengeId, response, name });
      if (!finish.ok) {
        setError(`${finish.error.message} ${PASSKEYS_PANEL_WORDS.deviceKept}`);
        return;
      }
      if (finish.data.firstPasskey && mustSaveCodes) {
        const made = await generateMfaRecoveryCodesAction();
        if (made.ok) {
          setCodes(made.data.codes);
          setStep('codes');
          return;
        }
      }
      setStep('done');
    } catch (e) {
      if (isControlFlow(e)) return;
      setError(PASSKEYS_PANEL_WORDS.noAnswer);
    } finally {
      setPending(false);
    }
  }

  const closeAllowed = step !== 'codes' || saved;

  return (
    <Dialog open onOpenChange={(o) => (!o && closeAllowed && !pending ? onClose() : undefined)}>
      <DialogContent>
        {step === 'phone' ? (
          <>
            <DialogHeader>
              <DialogTitle>{PASSKEYS_PANEL_WORDS.phoneTitle}</DialogTitle>
              <DialogDescription>{PASSKEYS_PANEL_WORDS.phoneBody}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="passkey-phone-typed">{PASSKEYS_PANEL_WORDS.phoneTypeLabel}</Label>
              <Input id="passkey-phone-typed" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
            <DialogFooter>
              <Button asChild variant="outline">
                <a href="/dashboard/settings/security?enroll=1">{PASSKEYS_PANEL_WORDS.phoneAppFirst}</a>
              </Button>
              <Button onClick={() => setStep('before')} disabled={typed.trim().toLowerCase() !== 'i understand'}>
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : step === 'before' ? (
          <>
            <DialogHeader>
              <DialogTitle>{PASSKEYS_PANEL_WORDS.add}</DialogTitle>
              {/* The proof is the password only when the member has no other
                  method: only then does the first passkey sign out the other
                  devices (the lab walk of stage 4, finding 1). */}
              <DialogDescription>
                {addPasskeyBeforeWords(data.proof === 'password')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => setStep('proof')}>Continue</Button>
            </DialogFooter>
          </>
        ) : step === 'proof' ? (
          <>
            <DialogHeader>
              <DialogTitle>{PASSKEYS_PANEL_WORDS.add}</DialogTitle>
              <DialogDescription>
                {data.proof === 'password'
                  ? PASSKEYS_PANEL_WORDS.password
                  : useCode || data.proof === 'code'
                    ? PASSKEYS_PANEL_WORDS.code
                    : PASSKEYS_PANEL_WORDS.usePasskey}
              </DialogDescription>
            </DialogHeader>
            {data.proof === 'password' ? (
              <Input
                type="password"
                aria-label="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            ) : useCode || data.proof === 'code' ? (
              <div className="space-y-2">
                {data.apps.length > 1 ? (
                  <select
                    aria-label="Authenticator"
                    value={factorId}
                    onChange={(e) => setFactorId(e.target.value)}
                    className="h-9 w-full rounded-md border px-2 text-[13px]"
                  >
                    {data.apps.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.friendlyName ?? 'Authenticator'}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Input
                  aria-label="Authentication code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
              </div>
            ) : null}
            {data.proof === 'passkey_or_code' ? (
              <Button variant="link" className="px-0" onClick={() => setUseCode((v) => !v)}>
                {useCode ? PASSKEYS_PANEL_WORDS.usePasskey : PASSKEYS_PANEL_WORDS.code}
              </Button>
            ) : null}
            <div role="alert">{error ? <p className="text-destructive text-[12px]">{error}</p> : null}</div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={proofNext} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Continue'}
              </Button>
            </DialogFooter>
          </>
        ) : step === 'name' ? (
          <>
            <DialogHeader>
              <DialogTitle>{PASSKEYS_PANEL_WORDS.add}</DialogTitle>
              <DialogDescription>{PASSKEYS_PANEL_WORDS.name}</DialogDescription>
            </DialogHeader>
            <Input aria-label="Passkey name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <div role="alert">{error ? <p className="text-destructive text-[12px]">{error}</p> : null}</div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={add} disabled={pending || !name.trim()}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : PASSKEYS_PANEL_WORDS.add}
              </Button>
            </DialogFooter>
          </>
        ) : step === 'codes' ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
              <DialogDescription>{PASSKEYS_PANEL_WORDS.saveCodes}</DialogDescription>
            </DialogHeader>
            <ul className="grid grid-cols-2 gap-1 font-mono text-[13px]">
              {(codes ?? []).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              {PASSKEYS_PANEL_WORDS.savedCodes}
            </label>
            <DialogFooter>
              <Button onClick={() => setStep('done')} disabled={!saved}>
                Continue
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{PASSKEYS_PANEL_WORDS.add}</DialogTitle>
              <DialogDescription>{PASSKEYS_PANEL_WORDS.done}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Review 4 finding 4: a recovery code from the Security page, for a member
 * whose only method is a passkey whose setup is not finished (the code page
 * is not offered to an account with no verified factor). The same action as
 * the code page's: the password is required, and the code removes every
 * second step of the account, passkeys included.
 */
function RecoveryCodeDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [code, setCode] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || !password) return setError(PASSKEYS_PANEL_WORDS.recoveryMissing);
    setPending(true);
    setError(null);
    try {
      const res = await consumeMfaRecoveryCodeAction({ code: code.trim(), password });
      if (!res.ok) return setError(res.error.message);
      setPassword('');
      onClose();
      router.refresh();
    } catch (err) {
      if (isControlFlow(err)) return;
      setError(PASSKEYS_PANEL_WORDS.noAnswer);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{PASSKEYS_PANEL_WORDS.recoveryTitle}</DialogTitle>
          <DialogDescription>{PASSKEYS_PANEL_WORDS.recoveryBody}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="passkeys-recovery-code">Recovery code</Label>
            <Input
              id="passkeys-recovery-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="font-mono tracking-widest"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="passkeys-recovery-password">Your password</Label>
            <Input
              id="passkeys-recovery-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div role="alert">
            {error ? <p className="text-destructive text-[12px]">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Use recovery code'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
