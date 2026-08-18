'use client';

import * as React from 'react';

import { AUTH_STATE_EVENT, type AuthPhase } from '@/components/auth/auth-state';
import {
  crateLabel,
  ORDERED,
  PO,
  RACK_HOLDING,
  RECEIVED,
  STALE_ROW,
} from '@/components/marketing/landing/fixture';

/**
 * The animated panel beside the sign-in form.
 *
 * The message is "you are signing back into your operation" — so this is a
 * StockPilot product scene, not warehouse stock photography. One purchase order
 * moves through the system on a slow loop: ordered, received, staged, placed.
 *
 * It reads from the SAME fixture the landing page uses, so a visitor who just
 * scrolled the marketing story sees the same purchase order here. If the two
 * drifted, the seam between marketing and product would be visible on the exact
 * screen that is supposed to prove there is no seam.
 *
 * IT ALSO RESPONDS TO THE FORM — the field you are in, the request in flight,
 * the moment it succeeds. That signal is one-way and purely cosmetic: no
 * authentication decision reads it, and if this component is absent or broken,
 * signing in behaves identically. See auth-state.ts.
 *
 * COST DISCIPLINE. Pure DOM and CSS keyframes: no canvas, no video, no image
 * request, and emphatically none of the landing page's frame sequence — loading
 * a 70MB scrub on /signin would be indefensible on a screen whose entire job is
 * to be fast. The form is usable from first paint regardless of this.
 *
 * Reduced motion is handled in CSS: same composition, every row settled, nothing
 * moving.
 */

const STEPS = [
  { k: 'Ordered', v: `${ORDERED} expected`, meta: PO.number },
  { k: 'Received', v: `${RECEIVED} of ${ORDERED}`, meta: 'one line over-received' },
  { k: 'Staged', v: `${RECEIVED} staged`, meta: `1 stale · ${STALE_ROW.ageDays}d` },
  { k: 'Placed', v: crateLabel(RACK_HOLDING.crate), meta: `${RACK_HOLDING.qty} units` },
];

/** Which row the panel leans on while a given field has focus. */
const FOCUS_ROW: Partial<Record<AuthPhase, number>> = { email: 0, password: 3 };

export function AuthStage() {
  const [phase, setPhase] = React.useState<AuthPhase>('idle');

  React.useEffect(() => {
    const onState = (e: Event) => setPhase((e as CustomEvent<AuthPhase>).detail);
    window.addEventListener(AUTH_STATE_EVENT, onState);
    return () => window.removeEventListener(AUTH_STATE_EVENT, onState);
  }, []);

  const focusRow = FOCUS_ROW[phase];

  return (
    <div className="auth-stage" data-phase={phase} aria-hidden>
      <div className="auth-stage-head">
        <span className="auth-live" />
        <span className="auth-stage-org">DC4 Warehouse</span>
        <span className="auth-stage-sep">/</span>
        <span className="auth-stage-view">
          {phase === 'submitting'
            ? 'Verifying'
            : phase === 'success'
              ? 'Connected'
              : PO.supplier}
        </span>
      </div>

      <ol className="auth-flow">
        {STEPS.map((s, i) => (
          <li
            key={s.k}
            style={{ '--i': i } as React.CSSProperties}
            data-lit={focusRow === i ? '' : undefined}
          >
            <span className="af-rail" />
            <span className="af-k">{s.k}</span>
            <span className="af-v">{s.v}</span>
            <span className="af-meta">{s.meta}</span>
          </li>
        ))}
      </ol>

      <p className="auth-stage-foot">
        Every movement carries the actor, the reason and the prior quantity.
      </p>
    </div>
  );
}
