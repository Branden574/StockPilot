# StockPilot Email System — Implementation Prompt

Paste everything below into Claude Code (or any capable agent) at the root of the StockPilot codebase, alongside the design package files listed in "Source of truth."

---

You are implementing the complete redesigned StockPilot email system. The design work is finished and locked — your job is faithful implementation of ALL 24 live emails, 2 latent templates, and 2 proposed concepts, plus the shared component layer they compose from. Do not redesign, simplify layouts, or substitute your own copy, colors, or spacing.

## Source of truth (in the design package)

- `email-system/es-tokens.js` — canonical tokens (light + dark), the full 28-email registry (`EMAILS`: triggers, recipients, senders, reply-to, subjects, preheaders, CTAs, footer types, status treatments, motion assignments), motion specs (`MOTION`, `MOTION_GLOBAL`), and layout constants (`SPEC`). Treat every value here as normative.
- `email-system/templates/archetype-security.html`, `archetype-order-status.html`, `archetype-digest.html` — production-grade reference markup: table layout, inline CSS, MSO conditionals, mobile query, dark query, merge tags, bulletproof buttons. All other templates must follow these patterns exactly.
- Mockups (visual reference for every template): `es-security.jsx`, `es-invites.jsx`, `es-orders.jsx`, `es-fulfillment.jsx`, `es-rentals.jsx`, `es-digest.jsx`, `es-support.jsx`, with shared components in `es-core.jsx` and hero motion in `es-heroes.jsx`.

## Non-negotiable constraints

1. **Email-safe HTML only.** Nested tables with `role="presentation"`, fully inline CSS, single 600px column (max 640), no flex/grid, no JS, no forms, no video, no hover-dependent UI.
2. **One component layer.** Build the shared partials once (Handlebars/MJML/React Email — match the existing mail stack) and compose all 28 templates from them: `email-shell`, `brand-strip`, `status-pill` (7 variants: ok/info/warn/err/neutral/purple/sec-outlined), `hero-slot`, `headline` (+Tinos italic serif turn, one per email max), `cta-row`, `link-fallback`, `info-card`, `detail-grid`, `detail-row`, `item-table` (+per-line status column), `order-timeline` (done/current/upcoming/terminal — never render stages that don't apply), `banner`, `event-card`, `rental-asset-card`, `kpi-card`, `action-list`, `workspace-card`, `help-row`, `preview-banner`, `internal-strip`, and `footer` ×4 (essential / preference / external / internal). No template may carry private one-off UI.
3. **Tokens, not hex-by-feel.** Light: desk `#e8e5dd`, paper `#f6f4ef`, sunk `#eeece5`, ink `#0c0c0e/#2a2a2c/#5a5853/#8b887f`, hairline `rgba(12,12,14,.12)`. Dark: desk `#060607`, paper `#161617`, sunk `#1e1e20`, ink `#f6f4ef/#d5d2c9/#a5a29a/#7d7a72`, hairline `rgba(246,244,239,.13)`. Status pairs (fg/bg, light → dark) exactly as in `es-tokens.js`. Buttons: ink↔paper flip. No shadows inside email bodies.
4. **Type.** Space Grotesk (falls back Helvetica/Arial), JetBrains Mono for eyebrows/IDs/table heads (falls back Courier New), Tinos italic for the headline turn (falls back Georgia). H1 32px/-0.03em → 24px mobile; body 14.5/1.55; pills mono 10px caps 0.18em; legal 11px. Hierarchy must survive total webfont failure.
5. **Responsive.** `@media (max-width:620px)`: container 100%, padding 36→24px, H1 24px, grids stack, buttons full-width (≥44px height).
6. **Dark mode.** `@media (prefers-color-scheme: dark)` plus `[data-ogsc]` duplicates for Outlook.com. Repaint via tokens — never rely on client inversion. Ship light + dark logo PNGs; solid token backgrounds behind all critical text.
7. **Subjects & preheaders verbatim** from the `EMAILS` registry (including sender name and reply-to per email). Preheader = hidden div + `&nbsp;` padding. Where the registry lists a `rec:` refined subject, implement the current subject and leave the refinement as a code comment for product sign-off — do not silently change operationally significant wording.
8. **Motion assets.** 13 GIF/APNG assets per the motion board: 1200×440 @2x rendered at 600×220, GIF ≤300KB (APNG ≤600KB only where alpha is needed, never APNG-only), loop/duration per `MOTION`, frame 1 = complete resting composition (this is the Outlook and reduced-motion fallback), meaningful alt text, explicit width/height attributes. One asset max per email, above the fold, never carrying information absent from the text. No motion on: denied, cancelled, receipts, support ticket. Nothing celebratory on negative states.
9. **Personalization & fallbacks.** Use the platform's merge syntax for every `{{tag}}` in the archetypes. Every optional value needs an elegant fallback (e.g. no first name → "Hi —"). Never render `undefined`, `null`, empty braces, raw UUIDs, or internal table names.
10. **Weight.** HTML ≤102KB per email (Gmail clip protects the unsubscribe link); total ≤1MB with images.

## The 28 templates

Implement every row of `ES.EMAILS` (id → template):
- **Security (essential footer):** `pw-reset`, `signin` — IMPORTANT: the old sign-in copy claiming a manageable preference is removed; do not reintroduce it.
- **Invitations:** `team-invite`, `invite-reminder` (same family, explicitly a reminder with new expiry), `ws-ready`, `portal-invite` (external footer; explains the magic-link semantics; assumes zero StockPilot knowledge).
- **Orders (preference footer except `confirm` = essential):** `confirm`, `received`, `approved`, `denied` (reason verbatim in an err banner; no full-red styling), `transit`, `delivered`, `cancelled` (neutral, factual).
- **Latent — build behind a disabled feature flag, do NOT wire triggers:** `packing`, `staged`. Mark both `// LATENT: dispatch decision pending (see policy audit)`.
- **Fulfillment:** `partial` (split delivered/backordered stat cards + per-line status), `back-shipped`, `partial-receipt` (external footer, receipt language, no jargon), `return-prompt`.
- **Rentals (see policy flag below):** `rental-out`, `rental-returned`, `rental-overdue` (real dates and day counts only — no manufactured urgency).
- **Schedule (preference footer):** `sched-tmrw`, `sched-hour` (compact event card, amber state).
- **Digest (preference footer + one-click unsubscribe headers):** `digest`, `digest-preview` (purple preview strip; must render the all-clear state without looking broken).
- **Internal:** `support-ticket` (internal strip + compact footer; reply-to set to the customer).
- **Concepts — build behind a disabled flag, do NOT dispatch:** `support-received`, `support-resolved`.

## Policy flags — implement honestly, do not solve in HTML

- Rental emails currently have no preference backend. Render the preference footer only if the preference actually exists by ship time; otherwise use the essential footer and open a ticket referencing "rental classification decision."
- Public order emails (fulfillment family) have different suppression behavior — surface this to product; do not guess.
- Remove any settings toggle that has no sending email, or wire its sender — flag, don't decide.
- List-Unsubscribe + List-Unsubscribe-Post headers on every preference-controlled email.

## Acceptance checklist (run before calling it done)

- [ ] All 24 live templates render with realistic seed data; 2 latent + 2 concept templates exist behind flags with no dispatch path
- [ ] Litmus/Email on Acid pass: Gmail, Apple Mail, Outlook desktop + web, Yahoo, iOS Mail, Android Gmail, Samsung Mail
- [ ] Images blocked: every email still communicates (alt text, reserved heights, live text)
- [ ] Dark mode: light/dark screenshots for the 10 key emails match the "Responsive & Dark" canvas
- [ ] Mobile 375px: no horizontal scroll, stacked grids, full-width 44px buttons
- [ ] Long-value stress: long org name, long item name, long denial reason, missing first name, missing ETA — no overflow, no "undefined"
- [ ] Footers match category exactly; no unsubscribe on essential mail; explainer copy on external mail
- [ ] Subjects/preheaders/senders byte-identical to the registry
- [ ] Each email answers within one viewport: what happened, what it's about, do I act, how urgent, what's next, where's help

Work template-family by template-family (shared layer → security → invitations → orders → fulfillment → rentals → schedule → digest → support), commit per family, and show rendered output as you go.
