/**
 * A one-way signal from the auth form to the decorative panel beside it.
 *
 * The visual column reacts to what the user is doing — the field they are in,
 * the moment the request is in flight, the moment it succeeds. It is published
 * as a DOM event rather than lifted into React state on purpose:
 *
 *   - the form and the panel are in different trees (the panel lives in the
 *     layout, the form in the page), so there is no shared provider to use
 *     without wrapping every auth route in one;
 *   - nothing about the form may re-render because the decoration changed;
 *   - and if the panel is absent — mobile, or a future auth screen that does not
 *     want it — publishing is a no-op rather than an error.
 *
 * STRICTLY ONE-WAY AND STRICTLY COSMETIC. The panel never signals back, and no
 * authentication decision may ever read this. If the panel is broken, missing or
 * ignored, sign-in behaves identically.
 */

export type AuthPhase = 'idle' | 'email' | 'password' | 'submitting' | 'success';

export const AUTH_STATE_EVENT = 'sp:auth-state';

export function publishAuthState(phase: AuthPhase): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_STATE_EVENT, { detail: phase }));
}
