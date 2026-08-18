/**
 * Landing CSS, scoped entirely under `#sp-landing`.
 *
 * NOTHING here may leak: the dashboard shares this document's globals, so every
 * selector below is prefixed. The only unprefixed ids are `#sp-stage`,
 * `#sp-poster`, `#sp-scrim` and `#sp-grain`, which are the fixed ground layer
 * and exist only on `/`.
 *
 * COLOUR: this is a refinement of the shipped palette, not a rebrand. Mint
 * (#5db89f) stays the single accent, amber (#ce983b) stays the single alarm,
 * warm paper (#faf9f4) and green-black ink stay the grounds. What is new is a
 * mid-tone surface ramp between stage and paper, a defined radius scale, and
 * hairlines that hold up at 1px on a retina panel.
 *
 * `--stage: #0b0c0a` IS LOCKED. It must stay byte-identical to `LI.ink` in
 * lib/landing-intro/timeline.ts or the intro's reveal shows a seam.
 *
 * Z-INDEX CEILING: nothing fixed may reach 60. The intro overlay sits at 60 and
 * anything at or above it punches through the curtain, which every E2E coverage
 * assertion reads as an uncovered frame.
 */
export const LANDING_CSS = `
#sp-landing{
  /* grounds — unchanged from the shipped identity */
  --stage:#0b0c0a;
  --paper:#faf9f4; --paper-2:#f4f3ee;
  --ink:#0e0f0d; --ink-2:#161713;

  /* NEW: a surface ramp. The old palette jumped straight from stage to paper,
     which is why every panel had to reach for backdrop-blur to separate. */
  --s-1:rgba(250,249,244,.035);
  --s-2:rgba(250,249,244,.055);
  --s-3:rgba(250,249,244,.08);

  /* one accent, one alarm — no third saturated hue anywhere on the page */
  --mint:#5db89f; --mint-bright:#7acdb8; --mint-dim:rgba(93,184,159,.16);
  --amber:#ce983b; --amber-bright:#e0ae52;

  --muted:#5a5d56;
  --line:#e7e5dd; --line-strong:#d4d2c8;
  --line-dark:rgba(250,249,244,.13); --line-dark-2:rgba(250,249,244,.07);
  --paper-dim:rgba(250,249,244,.62); --paper-dim-2:rgba(250,249,244,.40);

  /* machined, not consumer-pill */
  --r-xs:3px; --r-sm:4px; --r:6px; --r-lg:10px;

  --shadow-panel:0 1px 0 rgba(250,249,244,.04), 0 18px 48px -24px rgba(0,0,0,.8);

  position:relative; z-index:0; color:var(--paper);
  font-family:var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-variant-numeric:tabular-nums lining-nums;
}
#sp-landing *,#sp-landing *::before,#sp-landing *::after{box-sizing:border-box}
#sp-landing ::selection{background:var(--mint);color:var(--ink)}
#sp-landing a{color:inherit;text-decoration:none}
#sp-landing h1,#sp-landing h2,#sp-landing h3{font-family:var(--font-display);font-weight:600;margin:0}
#sp-landing p{margin:0}
#sp-landing .mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums lining-nums}
#sp-landing .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#sp-landing .wrap{max-width:1240px;margin:0 auto;padding:0 clamp(20px,5vw,64px)}

/* ── fixed cinematic ground ───────────────────────────────────────────────── */
/* #sp-stage's background is LOCKED to #0b0c0a — byte-identical to LI.ink in
   lib/landing-intro/timeline.ts. A one-byte drift is a visible seam when the
   branded intro lifts. */
#sp-stage{position:fixed;inset:0;z-index:0;background:#0b0c0a;overflow:hidden}
#sp-poster,#sp-film{position:absolute;inset:0;width:100%;height:100%;display:block}
#sp-poster{object-fit:cover}
/* The canvas fades up once the first frame has decoded, so the handoff from
   poster to film has no pop. Both are cover-fit to the same box. */
#sp-film{opacity:0;transition:opacity .5s ease}
#sp-film.on{opacity:1}
#sp-poster,#sp-film{filter:saturate(.8) contrast(1.06) brightness(.74)}

/* The scrim is SHAPED, not a flat wash. Burying good footage under a uniform
   rgba(0,0,0,.75) defeats the point of shooting it, so the gradient darkens
   only the side the copy currently occupies — the story publishes data-side
   as chapters advance. Always a floor of legibility, never a blackout. */
#sp-scrim{position:absolute;inset:0;pointer-events:none;
  transition:background 1.1s cubic-bezier(.4,0,.2,1);
  background:
    linear-gradient(180deg,rgba(11,12,10,.78) 0%,rgba(11,12,10,.22) 24%,rgba(11,12,10,.24) 62%,rgba(11,12,10,.86) 100%),
    linear-gradient(90deg,rgba(11,12,10,.92) 0%,rgba(11,12,10,.60) 40%,rgba(11,12,10,.08) 74%,rgba(11,12,10,0) 100%)}
#sp-stage[data-side="right"] #sp-scrim{
  background:
    linear-gradient(180deg,rgba(11,12,10,.78) 0%,rgba(11,12,10,.22) 24%,rgba(11,12,10,.24) 62%,rgba(11,12,10,.86) 100%),
    linear-gradient(270deg,rgba(11,12,10,.90) 0%,rgba(11,12,10,.62) 38%,rgba(11,12,10,.12) 72%,rgba(11,12,10,0) 100%)}
/* The closing chapter is the one wide, calm composition — let the room read. */
#sp-stage[data-side="wide"] #sp-scrim{
  background:
    linear-gradient(180deg,rgba(11,12,10,.72) 0%,rgba(11,12,10,.34) 26%,rgba(11,12,10,.40) 64%,rgba(11,12,10,.90) 100%),
    radial-gradient(120% 88% at 50% 46%,rgba(11,12,10,0) 34%,rgba(11,12,10,.58) 100%)}

#sp-grain{position:absolute;inset:0;pointer-events:none;opacity:.05;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")}
#sp-vignette{position:absolute;inset:0;pointer-events:none;
  box-shadow:inset 0 0 240px 48px rgba(0,0,0,.55)}

/* ── typography system ────────────────────────────────────────────────────── */
#sp-landing .eyebrow{font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--mint-bright);margin-bottom:18px;
  display:flex;align-items:center;gap:11px}
#sp-landing .eyebrow::before{content:"";width:22px;height:1px;background:var(--mint);flex:none}
#sp-landing h1{font-size:clamp(38px,6.4vw,74px);line-height:1.0;letter-spacing:-.035em;max-width:14ch}
#sp-landing h2{font-size:clamp(26px,3.5vw,44px);line-height:1.08;letter-spacing:-.028em;max-width:24ch}
#sp-landing h3{font-size:clamp(18px,1.9vw,24px);line-height:1.2;letter-spacing:-.02em}
#sp-landing .lede{margin-top:22px;font-size:clamp(15px,1.35vw,18px);line-height:1.55;
  color:var(--paper-dim);max-width:56ch}
#sp-landing .sect-head{margin-bottom:clamp(36px,5vw,64px);max-width:1240px}
#sp-landing .sect-sub{margin-top:16px;font-size:15px;line-height:1.6;color:var(--paper-dim);max-width:62ch}

/* ── buttons: three rungs at constant geometry ────────────────────────────── */
#sp-landing .btn{display:inline-flex;align-items:center;gap:9px;height:42px;padding:0 20px;
  border-radius:var(--r);font-family:var(--font-display);font-size:14.5px;font-weight:560;
  letter-spacing:-.01em;border:1px solid transparent;transition:background .18s ease,border-color .18s ease,color .18s ease}
#sp-landing .btn.primary{background:var(--mint);color:var(--ink);border-color:var(--mint)}
#sp-landing .btn.primary:hover{background:var(--mint-bright);border-color:var(--mint-bright)}
#sp-landing .btn.ghost{border-color:var(--line-dark);color:var(--paper)}
#sp-landing .btn.ghost:hover{border-color:var(--paper-dim);background:var(--s-1)}
#sp-landing .btn:focus-visible,#sp-landing a:focus-visible,#sp-landing button:focus-visible{
  outline:2px solid var(--mint-bright);outline-offset:2px}

/* ── nav: an opaque plate, present at first paint ─────────────────────────── */
#sp-landing .sp-nav{position:fixed;top:0;left:0;right:0;z-index:40;
  display:flex;align-items:center;justify-content:space-between;gap:24px;
  height:60px;padding:0 clamp(18px,4vw,52px);
  background:rgba(11,12,10,.86);
  border-bottom:1px solid transparent;
  transition:border-color .3s ease,backdrop-filter .3s ease}
@supports (backdrop-filter:blur(1px)){
  #sp-landing .sp-nav{backdrop-filter:blur(16px) saturate(1.4)}
}
/* Scroll state ADDS a hairline. It never changes height, never resizes the
   glyph, never relocates an item — the intro's flight target must be stable. */
#sp-landing .sp-nav.scrolled{border-bottom-color:var(--line-dark)}
#sp-landing .brand{display:flex;align-items:center;gap:10px;flex:none;padding:0}
#sp-landing .glyph{width:26px;height:26px;flex:none}
#sp-landing .wordmark{font-family:var(--font-display);font-weight:600;letter-spacing:-.02em;
  font-size:17px;color:var(--paper)}
#sp-landing .wordmark span{font-weight:500;opacity:.55}
#sp-landing .nav-links{display:flex;align-items:center;gap:26px}
#sp-landing .nav-links a{font-size:13.5px;color:var(--paper-dim);transition:color .18s ease}
#sp-landing .nav-links a:hover{color:var(--paper)}
#sp-landing .nav-right{display:flex;align-items:center;gap:12px}
#sp-landing .nav-status{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);
  font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--paper-dim-2);
  padding-right:4px}
#sp-landing .live{width:6px;height:6px;border-radius:50%;background:var(--mint);flex:none;
  box-shadow:0 0 0 3px var(--mint-dim)}
#sp-landing .nav-theme{color:var(--paper);display:inline-flex}
#sp-landing .nav-signin{font-size:13.5px;color:var(--paper-dim);padding:0 4px}
#sp-landing .nav-signin:hover{color:var(--paper)}
#sp-landing .nav-cta{display:inline-flex;align-items:center;height:34px;padding:0 15px;
  border-radius:var(--r-sm);background:var(--mint);color:var(--ink);
  font-family:var(--font-display);font-size:13.5px;font-weight:560}
#sp-landing .nav-cta:hover{background:var(--mint-bright)}
#sp-landing .menu-btn{display:none;width:38px;height:34px;align-items:center;justify-content:center;
  background:none;border:1px solid var(--line-dark);border-radius:var(--r-sm);color:var(--paper);
  cursor:pointer;padding:0}
#sp-landing .menu-btn svg{width:18px;height:18px}
#sp-landing .mobile-menu{position:fixed;inset:60px 0 0;z-index:39;background:rgba(11,12,10,.98);
  display:flex;flex-direction:column;justify-content:space-between;
  padding:8px clamp(18px,4vw,52px) 28px;overflow-y:auto}
#sp-landing .mobile-menu ol{list-style:none;margin:0;padding:0}
#sp-landing .mobile-menu li a{display:flex;align-items:center;gap:14px;padding:17px 2px;
  font-size:17px;color:var(--paper);border-bottom:1px solid var(--line-dark-2)}
#sp-landing .mm-i{font-size:11px;color:var(--paper-dim-2);letter-spacing:.08em}
#sp-landing .mm-arrow{margin-left:auto;color:var(--paper-dim-2)}
#sp-landing .mm-foot{padding-top:24px;display:flex;flex-direction:column;gap:12px}
#sp-landing .mm-rule{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;
  color:var(--paper-dim-2);padding-bottom:10px;border-bottom:1px solid var(--line-dark-2)}
#sp-landing .mm-signin{padding:12px 2px;font-size:15px;color:var(--paper-dim)}
#sp-landing .mm-cta{display:flex;align-items:center;justify-content:center;height:46px;
  border-radius:var(--r);background:var(--mint);color:var(--ink);
  font-family:var(--font-display);font-weight:560;font-size:15px}

/* ── main flow ────────────────────────────────────────────────────────────── */
#sp-landing .sp-main{position:relative;z-index:10}
#sp-film-range{position:relative}
#sp-landing section{position:relative}

/* ── hero ─────────────────────────────────────────────────────────────────── */
#sp-landing .hero{padding:clamp(120px,17vh,190px) 0 0;overflow:hidden}
#sp-landing .hero-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}
#sp-landing .segmented{display:inline-flex;margin-top:46px;border:1px solid var(--line-dark);
  border-radius:var(--r);overflow:hidden}
#sp-landing .segmented button{appearance:none;background:none;border:0;
  border-right:1px solid var(--line-dark);height:34px;padding:0 15px;cursor:pointer;
  font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--paper-dim-2);transition:color .18s ease,background .18s ease}
#sp-landing .segmented button:last-child{border-right:0}
#sp-landing .segmented button:hover{color:var(--paper)}
#sp-landing .segmented button.on{background:var(--s-2);color:var(--paper)}
#sp-landing .hero-kpis{display:flex;flex-wrap:wrap;gap:0;margin-top:26px}
#sp-landing .kpi{padding-right:34px;margin-right:34px;border-right:1px solid var(--line-dark-2)}
#sp-landing .kpi:last-child{border-right:0;margin-right:0;padding-right:0}
#sp-landing .kpi .k{display:block;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--paper-dim-2)}
#sp-landing .kpi .v{display:block;font-family:var(--font-display);font-size:clamp(26px,3vw,36px);
  font-weight:500;letter-spacing:-.03em;line-height:1.1;margin-top:6px}
#sp-landing .kpi.alarm .v{color:var(--amber-bright)}
#sp-landing .kpi .f{display:block;font-size:12px;color:var(--paper-dim-2);margin-top:5px}
/* inset left, sliced by the right edge, cut by the fold */
/* Inset from the left gutter, then run PAST the right edge sliced mid-column.
   A fully contained window is a finite object the eye finishes; a fragment
   asserts the tool is larger than the frame can hold. */
#sp-landing .hero-console{margin-top:clamp(44px,6vw,72px);
  padding-left:max(clamp(20px,5vw,64px), calc((100vw - 1240px) / 2 + clamp(20px,5vw,64px)));
  padding-right:0;max-height:clamp(340px,44vh,470px);overflow:hidden}
#sp-landing .hero-console .console{border-top-right-radius:0;border-bottom-right-radius:0;
  border-right:0;margin-right:-1px}
#sp-landing .hero-console .tick.tr,#sp-landing .hero-console .tick.br{display:none}
#sp-landing .hero-band{position:relative;z-index:10;margin-top:0;
  border-top:1px solid var(--line-dark);border-bottom:1px solid var(--line-dark);
  background:rgba(11,12,10,.55)}
#sp-landing .hero-band dl{display:flex;flex-wrap:wrap;margin:0;padding:20px 0}
#sp-landing .hero-band dl > div{flex:1 1 200px;padding-right:26px}
#sp-landing .hero-band dt{font-family:var(--font-mono);font-size:10px;letter-spacing:.15em;
  text-transform:uppercase;color:var(--paper-dim-2)}
#sp-landing .hero-band dd{margin:6px 0 0;font-size:13.5px;color:var(--paper)}

/* ── the console ──────────────────────────────────────────────────────────── */
#sp-landing .console{position:relative;border:1px solid var(--line-dark);border-radius:var(--r-lg);
  background:rgba(9,10,8,.82);box-shadow:var(--shadow-panel);overflow:hidden}
@supports (backdrop-filter:blur(1px)){
  #sp-landing .console{backdrop-filter:blur(14px)}
}
#sp-landing .tick{position:absolute;width:6px;height:6px;z-index:2;
  border-color:var(--paper-dim-2);border-style:solid;border-width:0}
#sp-landing .tick.tl{top:6px;left:6px;border-top-width:1px;border-left-width:1px}
#sp-landing .tick.tr{top:6px;right:6px;border-top-width:1px;border-right-width:1px}
#sp-landing .tick.bl{bottom:6px;left:6px;border-bottom-width:1px;border-left-width:1px}
#sp-landing .tick.br{bottom:6px;right:6px;border-bottom-width:1px;border-right-width:1px}
#sp-landing .console-head{display:flex;align-items:center;gap:8px;padding:11px 16px;
  border-bottom:1px solid var(--line-dark-2);font-family:var(--font-mono);font-size:11px;
  letter-spacing:.05em;color:var(--paper-dim-2)}
#sp-landing .console-view{color:var(--paper-dim)}
#sp-landing .console-body{padding:4px 0}
#sp-landing .console-foot{display:flex;align-items:center;gap:8px;padding:9px 16px;
  border-top:1px solid var(--line-dark-2);font-family:var(--font-mono);font-size:10.5px;
  letter-spacing:.05em;color:var(--paper-dim-2)}

/* ── mirrored product surfaces ────────────────────────────────────────────── */
#sp-landing .grid{width:100%;border-collapse:collapse;font-size:12.5px}
#sp-landing .grid th{height:30px;padding:0 14px;text-align:left;
  font-family:var(--font-mono);font-size:10px;font-weight:400;letter-spacing:.09em;
  text-transform:uppercase;color:var(--paper-dim-2);border-bottom:1px solid var(--line-dark-2)}
/* horizontal hairlines only — a vertical column rule is what makes a table
   read as a 2009 admin panel. Alignment and whitespace separate instead. */
#sp-landing .grid td{padding:9px 14px;border-bottom:1px solid var(--line-dark-2);vertical-align:middle}
#sp-landing .grid tbody tr:last-child td{border-bottom:0}
#sp-landing .grid .num{text-align:right;font-variant-numeric:tabular-nums}
#sp-landing .grid tfoot td{border-top:1px solid var(--line-dark);border-bottom:0;
  padding-top:10px;color:var(--paper-dim)}
#sp-landing .grid.tight td,#sp-landing .grid.tight th{padding-top:7px;padding-bottom:7px}
#sp-landing .ttl{display:block;color:var(--paper);font-weight:450}
#sp-landing .ttl.trunc{max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sp-landing .sub{display:block;font-size:10.5px;color:var(--paper-dim-2);margin-top:2px}
#sp-landing .sm{font-size:11px}
#sp-landing .dim{color:var(--paper-dim-2)}
#sp-landing .strong{color:var(--paper);font-weight:500}
#sp-landing .warn-ink{color:var(--amber-bright)}
#sp-landing .alarm-ink{color:var(--amber-bright)}
#sp-landing .flagged{background:rgba(206,152,59,.055)}
#sp-landing .generic{font-size:10.5px;font-style:italic;color:var(--paper-dim-2)}
/* state = dot + neutral word. Colour appears only where it is information. */
#sp-landing .state{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;color:var(--paper-dim)}
#sp-landing .state-dot{width:5px;height:5px;border-radius:50%;background:var(--paper-dim-2);flex:none}
#sp-landing .state.ok .state-dot{background:var(--mint)}
#sp-landing .state.warn .state-dot{background:var(--amber)}
#sp-landing .state.alarm .state-dot{background:var(--amber-bright)}
#sp-landing .srcbadge{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:var(--r-xs);
  border:1px solid var(--line-dark);font-size:9.5px;letter-spacing:.04em;color:var(--paper-dim-2)}
#sp-landing .srcbadge.unplaced{border-style:dashed}
#sp-landing .stale{display:inline-block;margin-left:7px;padding:1px 6px;border-radius:var(--r-xs);
  background:rgba(206,152,59,.16);color:var(--amber-bright);font-size:9.5px;letter-spacing:.05em}
#sp-landing .swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px;
  border:1px solid rgba(0,0,0,.35);vertical-align:-1px}
#sp-landing .place{padding:16px}
#sp-landing .place-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:14px}
#sp-landing .place-head .lbl{font-family:var(--font-mono);font-size:10px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--paper-dim)}
#sp-landing .place-head .hint{font-size:11.5px;color:var(--paper-dim-2)}
#sp-landing .place-row{display:grid;grid-template-columns:1fr auto 44px;gap:14px;align-items:center;
  padding:11px 0;border-bottom:1px solid var(--line-dark-2)}
#sp-landing .place-dest{display:flex;align-items:center;font-size:11.5px;color:var(--paper-dim)}
#sp-landing .nullrack{margin-left:9px;padding:1px 6px;border-radius:var(--r-xs);
  border:1px dashed var(--line-dark);font-size:9.5px;color:var(--paper-dim-2)}
#sp-landing .place-qty{text-align:right;font-size:13px;color:var(--paper)}
#sp-landing .place-note{margin-top:14px;font-size:11.5px;line-height:1.55;color:var(--paper-dim-2)}
#sp-landing .split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
#sp-landing .split-cell{border:1px solid var(--line-dark-2);border-radius:var(--r);padding:13px}
#sp-landing .split-cell .k,#sp-landing .stat .k{display:block;font-family:var(--font-mono);
  font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--paper-dim-2)}
#sp-landing .split-cell .v,#sp-landing .stat .v{display:block;font-size:24px;font-weight:500;
  letter-spacing:-.02em;margin-top:6px;color:var(--paper)}
#sp-landing .split-cell .f{display:block;font-size:11px;color:var(--paper-dim-2);margin-top:5px}
#sp-landing .statrow{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:14px}
#sp-landing .stat{border:1px solid var(--line-dark-2);border-radius:var(--r);padding:10px 11px}
#sp-landing .stat.alarm{border-color:rgba(206,152,59,.34)}
#sp-landing .stat.alarm .v{color:var(--amber-bright)}

/* ── the story ────────────────────────────────────────────────────────────── */
#sp-landing .story{padding:clamp(72px,11vw,140px) 0 clamp(48px,7vw,90px)}
#sp-landing .story-head{margin-bottom:clamp(40px,6vw,80px)}
#sp-landing .story-grid{display:grid;grid-template-columns:minmax(0,0.86fr) minmax(0,1.14fr);
  gap:clamp(32px,5vw,72px);align-items:start}
#sp-landing .story-steps{display:flex;flex-direction:column}
#sp-landing .step{min-height:76vh;display:flex;flex-direction:column;justify-content:center;
  padding:24px 0;opacity:.34;transition:opacity .4s ease}
#sp-landing .step.on{opacity:1}
#sp-landing .step-code{font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--mint-bright);margin-bottom:16px}
#sp-landing .step-code span{color:var(--paper-dim-2);margin-left:10px}
#sp-landing .step h3{max-width:20ch}
#sp-landing .step-detail{margin-top:16px;font-size:14.5px;line-height:1.62;color:var(--paper-dim);
  max-width:52ch}
#sp-landing .story-pin{position:sticky;top:90px;display:flex;flex-direction:column;gap:16px}
#sp-landing .rail{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;list-style:none;
  margin:0;padding:0}
#sp-landing .rail li{height:2px;background:var(--line-dark-2);border-radius:1px;
  transition:background .35s ease}
#sp-landing .rail li.done{background:var(--paper-dim-2)}
#sp-landing .rail li.now{background:var(--mint)}
/* fixed row height so the ledger cannot shiver against the pinned console */
#sp-landing .ledger{list-style:none;margin:0;padding:0;border-top:1px solid var(--line-dark-2)}
#sp-landing .ledger li{display:grid;grid-template-columns:26px 1fr auto;gap:12px;align-items:center;
  height:30px;border-bottom:1px solid var(--line-dark-2);
  font-size:11.5px;color:var(--paper-dim-2);transition:color .3s ease}
#sp-landing .ledger li.past{color:var(--paper-dim)}
#sp-landing .ledger li.on{color:var(--paper)}
#sp-landing .ledger li.on .l-fig{color:var(--mint-bright)}
#sp-landing .l-code{font-size:10px;letter-spacing:.06em}
#sp-landing .l-fig{font-size:11px;text-align:right}
#sp-landing .story-mobile{display:none}

/* ── lattice ──────────────────────────────────────────────────────────────── */
#sp-landing .lattice,#sp-landing .index,#sp-landing .compare,#sp-landing .posture{
  padding:clamp(64px,9vw,120px) 0;background:var(--ink);border-top:1px solid var(--line-dark-2)}
#sp-landing .lat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;
  background:var(--line-dark-2);border:1px solid var(--line-dark-2);border-radius:var(--r-lg);
  overflow:hidden}
#sp-landing .lat-cell{background:var(--ink);padding:22px}
#sp-landing .lat-cell.hero-cell{grid-column:span 2;grid-row:span 2}
#sp-landing .lat-cell.promoted{grid-column:span 2}
#sp-landing .lat-cell.small{display:flex;align-items:center;font-size:12.5px;
  color:var(--paper-dim);padding:16px 18px;
  opacity:calc(1 - (var(--i) * 0.035))}
#sp-landing .lat-lede{margin-top:11px;font-size:13px;line-height:1.55;color:var(--paper-dim);max-width:42ch}
#sp-landing .lat-rows{list-style:none;margin:18px 0 0;padding:0}
#sp-landing .lat-rows li{display:flex;justify-content:space-between;gap:16px;padding:8px 0;
  border-bottom:1px solid var(--line-dark-2);font-size:12px}
#sp-landing .lr-name{color:var(--paper-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sp-landing .lr-meta{font-size:11px;color:var(--paper-dim-2);flex:none}
#sp-landing .lr-flag .lr-name{color:var(--paper)}
#sp-landing .lat-foot{margin-top:16px;font-size:11px;color:var(--paper-dim-2)}
#sp-landing .lat-figs{display:flex;flex-wrap:wrap;gap:20px;margin-top:18px;font-size:12px;
  color:var(--paper-dim-2)}
#sp-landing .lat-figs b{font-size:19px;font-weight:500;color:var(--paper);margin-right:5px;
  letter-spacing:-.02em}
#sp-landing .lat-figs .alarm-ink b,#sp-landing .lat-figs .warn-ink b{color:var(--amber-bright)}
#sp-landing .stage-cols{display:grid;grid-template-columns:repeat(4,1fr);gap:clamp(20px,3vw,44px);
  margin-top:clamp(40px,5vw,72px)}
#sp-landing .stage-col{border-left:1px solid var(--line-dark);padding-left:18px}
#sp-landing .sc-k{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;
  color:var(--mint-bright);margin-bottom:14px}
#sp-landing .stage-col ul,#sp-landing .idx-col ul{list-style:none;margin:0;padding:0}
#sp-landing .stage-col li{font-size:12.5px;line-height:1.5;color:var(--paper-dim);padding:5px 0}

/* ── coverage index ───────────────────────────────────────────────────────── */
#sp-landing .idx-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:clamp(18px,2.5vw,36px)}
#sp-landing .idx-col{border-left:1px solid var(--line-dark);padding-left:16px}
#sp-landing .ic-k{font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;
  color:var(--mint-bright);margin-bottom:14px}
#sp-landing .idx-col li{font-size:12px;line-height:1.5;color:var(--paper-dim);padding:5px 0}

/* ── comparison ───────────────────────────────────────────────────────────── */
#sp-landing .cmp-scroll{overflow-x:auto}
#sp-landing .cmp{width:100%;min-width:820px;border-collapse:collapse;text-align:left}
#sp-landing .cmp th,#sp-landing .cmp td{padding:15px 16px;border-bottom:1px solid var(--line-dark-2);
  vertical-align:top}
#sp-landing .cmp thead th{font-family:var(--font-mono);font-size:10.5px;font-weight:400;
  letter-spacing:.09em;text-transform:uppercase;color:var(--paper-dim-2);
  border-bottom:1px solid var(--line-dark)}
#sp-landing .cmp tbody th{font-weight:450;font-size:13.5px;color:var(--paper);max-width:34ch}
#sp-landing .cmp .ours{background:var(--s-1)}
#sp-landing .cmp thead .ours{color:var(--mint-bright)}
/* three states, no red/green, no ticks and crosses — this reads as analysis,
   not a sales grid, and it stays clear of the product's own status semantics */
#sp-landing .mark{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--paper-dim)}
#sp-landing .mark-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--paper-dim-2)}
#sp-landing .mark.yes .mark-dot{background:var(--mint)}
#sp-landing .mark.part .mark-dot{background:transparent;box-shadow:inset 0 0 0 1px var(--paper-dim)}
#sp-landing .mark.no .mark-dot{background:transparent;box-shadow:inset 0 0 0 1px var(--line-dark)}
#sp-landing .mark.yes{color:var(--paper)}
#sp-landing .mark-note{display:block;margin-top:6px;font-size:11px;line-height:1.45;
  color:var(--paper-dim-2);max-width:30ch}

/* ── posture ──────────────────────────────────────────────────────────────── */
#sp-landing .post-list{list-style:none;margin:0;padding:0;max-width:74ch}
#sp-landing .post-list li{font-size:15px;line-height:1.6;color:var(--paper-dim);
  padding:13px 0 13px 22px;border-bottom:1px solid var(--line-dark-2);position:relative}
#sp-landing .post-list li::before{content:"";position:absolute;left:0;top:22px;width:8px;height:1px;
  background:var(--mint)}
#sp-landing .post-gap{margin-top:24px;font-size:15px;line-height:1.6;color:var(--paper-dim);
  max-width:74ch}
#sp-landing .facts{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:clamp(36px,5vw,64px) 0 0;
  background:var(--line-dark-2);border:1px solid var(--line-dark-2);border-radius:var(--r-lg);
  overflow:hidden}
#sp-landing .facts > div{background:var(--ink);padding:20px}
#sp-landing .facts dt{font-family:var(--font-mono);font-size:10px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--paper-dim-2)}
#sp-landing .facts dd{margin:9px 0 0;font-size:16px;color:var(--paper);letter-spacing:-.01em}
#sp-landing .facts p{margin-top:9px;font-size:10.5px;line-height:1.5;color:var(--paper-dim-2)}

/* ── the close ────────────────────────────────────────────────────────────── */
#sp-landing .close{padding:clamp(48px,7vw,96px) 0 clamp(28px,4vw,52px);background:var(--ink)}
#sp-landing .slab{position:relative;border:1px solid var(--line-dark);border-radius:14px;
  background:var(--ink-2);overflow:hidden}
#sp-landing .slab-top{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);
  gap:clamp(24px,4vw,56px);padding:clamp(30px,4.5vw,56px)}
#sp-landing .slab-list{list-style:none;margin:24px 0 0;padding:0}
#sp-landing .slab-list li{font-size:13.5px;line-height:1.5;color:var(--paper-dim);
  padding:7px 0 7px 20px;position:relative}
#sp-landing .slab-list li::before{content:"";position:absolute;left:0;top:15px;width:7px;height:1px;
  background:var(--mint)}
#sp-landing .slab-act{display:flex;flex-direction:column;gap:11px;align-items:flex-start;
  border-left:1px solid var(--line-dark-2);padding-left:clamp(20px,3vw,36px)}
#sp-landing .slab-act .btn{width:100%;justify-content:center}
#sp-landing .slab-note{margin-top:6px;font-size:12px;color:var(--paper-dim-2)}
#sp-landing .slab-note a{color:var(--paper-dim);text-decoration:underline;text-underline-offset:3px}
#sp-landing .slab-links{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) minmax(0,1.4fr);
  gap:clamp(20px,3vw,44px);padding:clamp(24px,3.5vw,40px) clamp(30px,4.5vw,56px);
  border-top:1px solid var(--line-dark-2)}
#sp-landing .fk{font-size:10px;letter-spacing:.17em;text-transform:uppercase;
  color:var(--paper-dim-2);margin-bottom:13px}
#sp-landing .slab-links ul{list-style:none;margin:0;padding:0}
#sp-landing .slab-links li{padding:5px 0}
#sp-landing .slab-links a{font-size:13px;color:var(--paper-dim)}
#sp-landing .slab-links a:hover{color:var(--paper)}
#sp-landing .slab-brand p{margin-top:14px;font-size:12px;line-height:1.55;color:var(--paper-dim-2);
  max-width:34ch}
#sp-landing .ftbrand{display:inline-flex;color:var(--paper)}
#sp-landing .ftbrand .glyph{width:24px;height:24px}
#sp-landing .slab-util{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;
  padding:15px clamp(30px,4.5vw,56px);border-top:1px solid var(--line-dark-2);
  font-size:10.5px;letter-spacing:.05em;color:var(--paper-dim-2)}
#sp-landing .slab-util span{display:inline-flex;align-items:center;gap:8px}
/* Stencilled into the slab the way a company name is painted on a warehouse
   wall: oversized, sliced at the baseline, and cropped by BOTH side edges.
   It was previously left-padded and only overflowed to the right, so it read as
   a clipping bug rather than a deliberate crop. Centring a nowrap line that is
   wider than its container overflows it equally on both sides, which is what
   makes the crop look intentional. */
/* The mark is drawn as SVG so it always FITS. Two earlier attempts failed: a
   clamp()-tuned font-size overflowed 382px at 1440 because the word's width
   depends on the loaded face, and text-align:center could not re-centre it,
   because browsers clamp the negative free space once a nowrap line exceeds its
   container. textLength fits the word to the box instead. */
#sp-landing .stencil{display:block;width:100%;height:auto;margin:0;
  color:var(--paper);opacity:.055;user-select:none;pointer-events:none}
#sp-landing .stencil text{fill:currentColor;font-family:var(--font-display);
  font-weight:600;font-size:205px}

/* ── light theme: the post-story sections flip to warm paper ─────────────── */
/* The hero and story stay dark in both themes — they sit on #sp-stage, whose
   colour the loading intro is byte-matched to and therefore cannot change. */
/* BACKGROUNDS HERE MUST BE LITERALS, NEVER var(--paper)/var(--ink).
   This block redefines those tokens, and a var() read on the SAME element
   resolves against the element's own new value — so background:var(--paper)
   would paint the redefined INK and put dark text on a dark ground. That bug
   made the whole coverage index invisible once. Inside this scope the
   --paper* tokens mean the INK side; the grounds are spelled out. */
html:not(.dark) #sp-landing .lattice,
html:not(.dark) #sp-landing .index,
html:not(.dark) #sp-landing .compare,
html:not(.dark) #sp-landing .posture,
html:not(.dark) #sp-landing .close{
  background:#faf9f4;color:#0e0f0d;
  --paper:#0e0f0d;
  --paper-dim:rgba(14,15,13,.74);
  --paper-dim-2:rgba(14,15,13,.52);
  --line-dark:rgba(14,15,13,.17);
  --line-dark-2:rgba(14,15,13,.10);
  --s-1:rgba(14,15,13,.028);
  --s-2:rgba(14,15,13,.05);
  --mint-bright:#2c7461;
  --amber-bright:#7d5a1c;
}
html:not(.dark) #sp-landing .lat-cell,
html:not(.dark) #sp-landing .facts > div{background:#f4f3ee}
html:not(.dark) #sp-landing .slab{background:#f4f3ee;border-color:rgba(14,15,13,.17)}
html:not(.dark) #sp-landing .lat-grid,
html:not(.dark) #sp-landing .facts{background:rgba(14,15,13,.10);border-color:rgba(14,15,13,.10)}
html:not(.dark) #sp-landing .stencil{color:#0e0f0d;opacity:.07}
html:not(.dark) #sp-landing .btn.primary{background:#2f7d68;color:#faf9f4;border-color:#2f7d68}
html:not(.dark) #sp-landing .flagged{background:rgba(206,152,59,.1)}

/* ── responsive: intentional compositions, not a squeeze ─────────────────── */
@media (max-width:1080px){
  #sp-landing .lat-grid{grid-template-columns:repeat(2,1fr)}
  #sp-landing .lat-cell.hero-cell,#sp-landing .lat-cell.promoted{grid-column:span 2;grid-row:auto}
  #sp-landing .idx-grid{grid-template-columns:repeat(3,1fr);row-gap:32px}
  #sp-landing .stage-cols{grid-template-columns:repeat(2,1fr);row-gap:32px}
  #sp-landing .facts{grid-template-columns:repeat(2,1fr)}
}
@media (max-width:900px){
  #sp-landing .nav-links,#sp-landing .nav-status,#sp-landing .nav-signin{display:none}
  #sp-landing .menu-btn{display:inline-flex}
  /* Desktop's sticky two-column story is REPLACED, not shrunk: a tall runway
     per step manufactures an endless page and fights momentum scrolling. */
  #sp-landing .story-grid{display:none}
  #sp-landing .story-mobile{display:block}
  #sp-landing .slab-top{grid-template-columns:1fr}
  #sp-landing .slab-act{border-left:0;padding-left:0;border-top:1px solid var(--line-dark-2);
    padding-top:24px}
  #sp-landing .slab-links{grid-template-columns:repeat(2,1fr);row-gap:28px}
}
@media (max-width:640px){
  #sp-landing .nav-cta{height:32px;padding:0 12px;font-size:13px}
  #sp-landing h1{font-size:clamp(34px,10vw,46px);max-width:16ch}
  #sp-landing .hero{padding-top:104px}
  #sp-landing .hero-console{padding-left:16px;max-height:300px}
  #sp-landing .hero-kpis{gap:18px}
  #sp-landing .kpi{padding-right:18px;margin-right:0;flex:1 1 128px}
  #sp-landing .kpi:nth-child(2){border-right:0}
  #sp-landing .segmented{width:100%;overflow-x:auto}
  #sp-landing .lat-grid{grid-template-columns:1fr}
  #sp-landing .lat-cell.hero-cell,#sp-landing .lat-cell.promoted{grid-column:span 1}
  #sp-landing .idx-grid,#sp-landing .stage-cols{grid-template-columns:1fr;row-gap:28px}
  #sp-landing .facts{grid-template-columns:1fr}
  #sp-landing .slab-links{grid-template-columns:1fr}
  #sp-landing .statrow{grid-template-columns:repeat(2,1fr)}
  #sp-landing .split{grid-template-columns:1fr}
  /* the dense table keeps its identity column and crops at the bezel */
  #sp-landing .console-body{overflow-x:auto}
  #sp-landing .grid{min-width:520px}
}

/* ── mobile story accordion ───────────────────────────────────────────────── */
#sp-landing .m-step{border-bottom:1px solid var(--line-dark-2)}
#sp-landing .m-step h3{margin:0;font-size:inherit;font-weight:inherit}
#sp-landing .m-step button{display:grid;grid-template-columns:26px 1fr auto;gap:12px;
  align-items:center;width:100%;min-height:56px;padding:12px 0;background:none;border:0;
  color:var(--paper);cursor:pointer;text-align:left;font-family:inherit}
#sp-landing .m-code{font-size:10.5px;letter-spacing:.08em;color:var(--paper-dim-2)}
#sp-landing .m-name{font-size:14.5px;font-family:var(--font-display);letter-spacing:-.015em}
#sp-landing .m-fig{font-size:10.5px;color:var(--paper-dim-2);text-align:right}
#sp-landing .m-step.on .m-fig{color:var(--mint-bright)}
#sp-landing .m-panel{padding:2px 0 22px}
#sp-landing .m-claim{font-family:var(--font-display);font-size:17px;line-height:1.25;
  letter-spacing:-.02em;margin-bottom:10px}
#sp-landing .m-detail{font-size:13.5px;line-height:1.6;color:var(--paper-dim);margin-bottom:16px}

/* ── scroll reveals below the film ────────────────────────────────────────── */
/* The hidden state is scoped to .reveal-armed, which reveal.tsx adds at runtime.
   With JS off the class never appears and everything renders visible. */
#sp-landing.reveal-armed [data-reveal]{opacity:0;transform:translateY(14px);
  transition:opacity .62s cubic-bezier(.22,.7,.2,1),transform .62s cubic-bezier(.22,.7,.2,1);
  transition-delay:calc(var(--r,0) * 55ms)}
#sp-landing.reveal-armed [data-reveal].is-in{opacity:1;transform:none}
/* Cells lift rather than slide — a grid that slides reads as a carousel. */
#sp-landing.reveal-armed .lat-cell[data-reveal]{transform:translateY(18px) scale(.985)}
#sp-landing.reveal-armed .lat-cell[data-reveal].is-in{transform:none}
/* Small cells keep their distance falloff while animating in. */
#sp-landing.reveal-armed .lat-cell.small[data-reveal].is-in{opacity:calc(1 - (var(--i) * 0.035))}
/* Comparison rows arrive as rows, not as a block. */
#sp-landing.reveal-armed .cmp tbody tr[data-reveal]{transform:translateY(10px)}
#sp-landing.reveal-armed .cmp tbody tr[data-reveal].is-in{transform:none}

/* ── reduced motion: the story must read with nothing running ─────────────── */
@media (prefers-reduced-motion:reduce){
  #sp-landing *,#sp-landing *::before,#sp-landing *::after{
    transition-duration:.001ms !important;animation-duration:.001ms !important;
    animation-iteration-count:1 !important;scroll-behavior:auto !important}
  /* every chapter legible at rest, none dimmed out of readability */
  #sp-landing .step{opacity:1;min-height:auto;padding:34px 0;
    border-bottom:1px solid var(--line-dark-2)}
  /* Reveals resolve instantly; reveal.tsx also skips arming entirely. */
  #sp-landing.reveal-armed [data-reveal]{opacity:1 !important;transform:none !important;
    transition:none !important}
  #sp-landing .story-pin{position:static}
  /* The film resolves to a single still; the scrim stops animating between
     chapters. The narrative is entirely in the DOM either way. */
  #sp-film{transition:none}
  #sp-scrim{transition:none}
}
`;
