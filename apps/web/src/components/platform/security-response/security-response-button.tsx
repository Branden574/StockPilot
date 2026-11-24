'use client';

import type { MouseEvent } from 'react';

import { Button } from '@/components/ui/button';

import { SECURITY_RESPONSE_CARD_LEVELS, SECURITY_RESPONSE_WORDS } from '@stockpilot/core';

import { useSecurityResponseHost, type SecurityResponseRequest } from './security-response-host';
import { SecurityResponseLevelBadge } from './security-response-level';

/**
 * "How to respond" on one entry (or one kind of the legend), with the card's
 * urgency badge beside it. It carries no card text: the card's id, its level,
 * and the words the entry already shows. The press opens the host's panel.
 * Outside a host it shows nothing.
 *
 * Its name is the visible words and then what the entry was ("How to
 * respond: Wrong password at sign-in"), so a list of them can be told apart.
 */

/** On the map's dark stage (the flagged panel): the stage's own focus ring and colours. */
const STAGE_BUTTON =
  'inline-flex h-7 items-center rounded-md border border-[rgba(160,190,240,.28)] px-2.5 text-[12px] font-medium text-[#cfe0ff] hover:bg-white/10 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9cc3ff] focus-visible:ring-0 focus-visible:ring-offset-0';

export function SecurityResponseButton({
  request,
  tone = 'page',
  showLevel = true,
  oneLine = false,
}: {
  request: SecurityResponseRequest;
  tone?: 'page' | 'stage';
  /** The badge beside the control: on every entry; not on a kind of the legend. */
  showLevel?: boolean;
  /**
   * The badge and the control on one line, never wrapped (a table's rows, so
   * every row is the same height whatever its badge says; lab walk 3, F4).
   * Otherwise the control goes under the badge when the room is short.
   */
  oneLine?: boolean;
}) {
  const host = useSecurityResponseHost();
  if (!host) return null;
  const level = SECURITY_RESPONSE_CARD_LEVELS[request.cardId];
  // The visible words first, then the entry's: one string, so every reader hears the same name.
  const name = SECURITY_RESPONSE_WORDS.openFor(request.what);
  const onClick = (event: MouseEvent<HTMLButtonElement>) => host.open(request, event.currentTarget);
  return (
    <span
      data-slot="security-response-control"
      data-level={level}
      className={
        oneLine
          ? 'inline-flex flex-nowrap items-center gap-x-2 whitespace-nowrap'
          : 'inline-flex flex-wrap items-center gap-x-2 gap-y-1'
      }
    >
      {showLevel ? <SecurityResponseLevelBadge level={level} tone={tone} /> : null}
      {tone === 'stage' ? (
        <button
          type="button"
          className={STAGE_BUTTON}
          onClick={onClick}
          onPointerEnter={host.preload}
          onFocus={host.preload}
          aria-label={name}
        >
          {SECURITY_RESPONSE_WORDS.open}
        </button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClick}
          onPointerEnter={host.preload}
          onFocus={host.preload}
          aria-label={name}
        >
          {SECURITY_RESPONSE_WORDS.open}
        </Button>
      )}
    </span>
  );
}
