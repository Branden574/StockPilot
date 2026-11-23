'use client';

import { KeyRound, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { useStepUp } from '@/components/auth/step-up-modal';
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
import {
  membersStillHoldingWords,
  PASSKEY_SETTING_LABEL,
  PASSKEYS_CONFIRM_WORD,
  PASSKEYS_COPY,
  type PlatformPasskeySetting,
} from '@/lib/platform/passkeys-console';
import {
  setNewPasskeysSwitchAction,
  setOrganizationPasskeysAction,
  setPasskeysKillSwitchAction,
  type OrganizationPasskeysSaved,
} from '@/server/actions/platform/passkeys';

import type { ActionResult } from '@stockpilot/core';

export type PasskeySwitchTarget =
  | { kind: 'platform'; setting: PlatformPasskeySetting }
  | { kind: 'organization'; organizationId: string; organizationName: string };

/** What the dialog says it will do, per target and direction. */
function wordsFor(target: PasskeySwitchTarget, turnOn: boolean) {
  const verb = turnOn ? 'Turn on' : 'Turn off';
  if (target.kind === 'organization') {
    const name = target.organizationName;
    return {
      name: `Passkeys for ${name}`,
      action: `${verb} passkeys for ${name}`,
      description: turnOn
        ? `Members of ${name} can add a passkey once passkeys for everyone and new passkeys are on, and every organization they belong to has passkeys on.`
        : `Members of ${name} can no longer add a passkey. Passkeys they already added keep working until they are removed.`,
    };
  }
  if (target.setting === 'passkeys_on') {
    return {
      name: PASSKEY_SETTING_LABEL.passkeys_on,
      action: `${verb} passkeys for everyone`,
      description: turnOn
        ? 'Passkeys can be used, and added where new passkeys and the organization allow it.'
        : 'Nobody can add or use a passkey. Members whose only second step is a passkey must use a recovery code.',
    };
  }
  return {
    name: PASSKEY_SETTING_LABEL.passkey_adds_on,
    action: `${verb} new passkeys`,
    description: turnOn
      ? 'Members of organizations with passkeys on can add a passkey while passkeys for everyone are on.'
      : 'Nobody can add a passkey. Passkeys already added keep working while passkeys for everyone are on.',
  };
}

function press(
  target: PasskeySwitchTarget,
  on: boolean,
  confirm: string,
): Promise<ActionResult<OrganizationPasskeysSaved>> {
  if (target.kind === 'organization') {
    return setOrganizationPasskeysAction({ organizationId: target.organizationId, on, confirm });
  }
  return target.setting === 'passkeys_on'
    ? setPasskeysKillSwitchAction({ on, confirm })
    : setNewPasskeysSwitchAction({ on, confirm });
}

/**
 * One passkey switch of the platform console (plan 2.6 H, section 4): "Off"
 * or "On", and a button that opens a confirm step asking for the typed word
 * PASSKEYS. The action re-gates on platform-admin and a FRESH step-up; when
 * that has lapsed it answers `aal2_required`, and the authenticator code is
 * asked for in place (useStepUp) and the same payload pressed again. The page
 * is refreshed after every answer, so it shows the switch as it is now.
 *
 * The dialog's direction is fixed when it opens. The refresh after an answer
 * can change `on` while the dialog is still open (an error keeps it open, and
 * an OFF that answered an error may have landed), so the dialog keeps asking
 * for, and pressing, the change it was opened for: it never turns into the
 * opposite change with the typed word still in the box.
 */
export function PasskeySwitchControl({ target, on }: { target: PasskeySwitchTarget; on: boolean }) {
  const router = useRouter();
  const stepUp = useStepUp();
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [pending, start] = React.useTransition();
  // What the open dialog asks for; set again each time it opens.
  const [turnOn, setTurnOn] = React.useState(!on);
  const words = wordsFor(target, turnOn);
  const inputId = React.useId();
  const armed = typed === PASSKEYS_CONFIRM_WORD && !pending;

  function onOpenChange(next: boolean) {
    if (pending) return;
    if (next) setTurnOn(!on);
    setOpen(next);
    if (!next) setTyped('');
  }

  function onConfirm() {
    if (!armed) return;
    start(async () => {
      let res = await press(target, turnOn, typed);
      if (!res.ok && res.error.details?.reason === 'aal2_required') {
        if (!(await stepUp.ensure())) return;
        res = await press(target, turnOn, typed);
      }
      router.refresh();
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      const state = res.data.on ? 'on' : 'off';
      const counted =
        target.kind === 'organization' && !res.data.on && res.data.membersWithPasskeys !== undefined
          ? ` ${membersStillHoldingWords(res.data.membersWithPasskeys)}`
          : '';
      if (!res.data.changed) {
        // An OFF's answer is the switch as read again after the press.
        toast.info(`${words.name} is already ${state}.`);
      } else if (!res.data.recorded) {
        // An OFF is made even when its record cannot be written; say both.
        toast.warning(`${PASSKEYS_COPY.offNotRecorded}${counted}`);
      } else {
        toast.success(`${words.name}: ${res.data.on ? 'On' : 'Off'}.${counted}`);
      }
      setOpen(false);
      setTyped('');
    });
  }

  return (
    <>
      {stepUp.modal}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <span className="inline-flex items-center gap-3">
          <span className={on ? 'text-foreground font-medium' : 'text-muted-foreground'}>
            {on ? 'On' : 'Off'}
          </span>
          <Button
            type="button"
            size="sm"
            variant={on ? 'outline' : 'default'}
            onClick={() => onOpenChange(true)}
            className="max-sm:h-11"
          >
            {on ? 'Turn off' : 'Turn on'}
          </Button>
        </span>

        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" strokeWidth={1.75} aria-hidden />
              {words.action}?
            </DialogTitle>
            <DialogDescription>{words.description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor={inputId}>Type {PASSKEYS_CONFIRM_WORD} to confirm</Label>
            <Input
              id={inputId}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value.trim())}
              disabled={pending}
            />
            <p className="text-muted-foreground text-[12px]">
              Needs a fresh authenticator code. Recorded in the platform audit.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={turnOn ? 'default' : 'destructive'}
              onClick={onConfirm}
              disabled={!armed}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {words.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
