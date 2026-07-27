/**
 * Critical intro CSS + the pre-hydration paint layer.
 *
 * Rendered from the (marketing) layout (a Server Component), so the branded ink
 * surface exists in the very first paint — before React hydrates. The React
 * overlay then takes over and drives the beam, the readiness gate and the flight.
 *
 * The pre-paint layer deliberately shows INK + GRID ONLY, not the lockup the
 * design brief mentions: on a first visit the lockup is revealed by the beam
 * from t=120ms, so painting it statically first would show the finished logo,
 * hide it again, then wipe it back in. Ink + grid is the branded surface with no
 * pop. (Repeat visits never render this layer at all — the gate script below
 * hides it before first paint.)
 *
 * Everything animates transform / opacity / clip-path only; nothing here reads
 * or writes layout, so the intro cannot contribute CLS.
 */

/** Ink is byte-identical to the hero's #sp-stage so the reveal shows no seam. */
const INK = '#0b0c0a';
const PAPER = '#faf9f4';
const MINT = '#5db89f';
const GRID_LINE = 'rgba(250,249,244,0.045)';

const CSS = `
.li-root,#li-pre{position:fixed;inset:0;z-index:60;overflow:hidden;background:${INK};
  cursor:pointer;will-change:opacity}
.li-grid{position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(${GRID_LINE} 1px,transparent 1px),linear-gradient(90deg,${GRID_LINE} 1px,transparent 1px);
  background-size:56px 56px;background-position:-28px -28px;
  -webkit-mask-image:radial-gradient(ellipse at 50% 44%,#000 26%,transparent 72%);
  mask-image:radial-gradient(ellipse at 50% 44%,#000 26%,transparent 72%)}
.li-lockpos{position:absolute;transform:translate(-50%,-50%)}
.li-lock{display:flex;align-items:center;transform-origin:left center;
  will-change:transform,opacity,clip-path}
.li-markwrap{position:relative;flex:none}
.li-word{font-family:var(--font-display),system-ui,sans-serif;font-weight:600;
  letter-spacing:-.025em;line-height:1;color:${PAPER};white-space:nowrap}
.li-word span{font-weight:500;opacity:.55}
.li-beam{position:absolute;top:0;bottom:0;pointer-events:none;will-change:transform,opacity}
.li-beam-tail{position:absolute;top:0;bottom:0;right:0;width:90px;
  background:linear-gradient(90deg,transparent,rgba(250,249,244,.09) 72%,rgba(250,249,244,.55))}
.li-beam-edge{position:absolute;top:0;bottom:0;right:-1px;width:1.5px;background:${PAPER};opacity:.9}
.li-pulse{position:absolute;width:0;height:0}
.li-pulse-ring{position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;
  border:1.5px solid ${MINT}}
.li-pulse-dot{position:absolute;left:-3.5px;top:-3.5px;width:7px;height:7px;border-radius:50%;
  background:${MINT}}
.li-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
/* The page's own brand hides only while the overlay owns the logo, so the two are
   never both visible. Never applied for crawlers or no-JS — JS adds the class. */
#sp-landing .brand{transition:opacity .15s ease}
#sp-landing .brand.li-brand-hidden{opacity:0}

html[data-li="skip"] #li-pre{display:none}
/* Failsafe: if hydration never happens, the curtain lifts itself. */
#li-pre{animation:li-failsafe .4s 4s forwards}
@keyframes li-failsafe{to{opacity:0;pointer-events:none;visibility:hidden}}

@media (prefers-reduced-motion:reduce){
  .li-beam{display:none}
  #li-pre{animation-delay:1.2s}
}
`;

/**
 * Runs before first paint. Sets the skip flag so a repeat visitor never sees a
 * frame of the pre-paint curtain. Static string, no interpolation — inline
 * scripts in Next.js require dangerouslySetInnerHTML and the app's CSP allows
 * 'unsafe-inline' for script-src.
 */
const GATE = `(function(){try{if(sessionStorage.getItem('stockpilot:intro-seen:v1')==='1')` +
  `document.documentElement.setAttribute('data-li','skip')}catch(e){}})()`;

export function IntroCriticalStyles() {
  return (
    <>
      <style>{CSS}</style>
      <script dangerouslySetInnerHTML={{ __html: GATE }} />
      <noscript>
        <style>{`#li-pre{display:none}`}</style>
      </noscript>
      {/* Pre-hydration curtain. Renders exactly what the live overlay's frame 0
          renders — flat ink, no grid — so the swap to the React overlay is a
          no-op on screen. (The grid deliberately fades 0 -> 0.9 over the first
          200ms of the sequence; painting it here would make it blink off, then
          on, at the handoff.) */}
      <div id="li-pre" aria-hidden="true" />
    </>
  );
}
